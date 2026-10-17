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
      glassMask(e, rng, style, wx, wy, ww, wh, x0, cell);
    }
  }
  return { map: toTexture(cm), emissive: toTexture(ce), rough: toTexture(cr, false) };
}

/**
 * Night glass mask of one window: how much of it can glow (brighter under the ceiling, with
 * blinds, curtains and frames). Whether a window is lit, and in which colour, is decided per
 * window and per building by the facade shader in city.ts, so nothing here is lit or unlit.
 */
function glassMask(e: CanvasRenderingContext2D, rng: Rng, style: FacadeStyle, wx: number, wy: number, ww: number, wh: number, x0: number, cell: number): void {
  const g = e.createLinearGradient(0, wy, 0, wy + wh);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.3, '#e4e4e4');
  g.addColorStop(1, '#8a8a8a');
  e.fillStyle = g;
  e.fillRect(wx + 1, wy + 1, ww - 2, wh - 2);
  const r = rng.next();
  if (r < 0.28) {
    // Venetian blinds lowered part of the way: a dim, slatted band from the top.
    const bh = (wh - 2) * rng.range(0.2, 0.8);
    e.fillStyle = 'rgba(0,0,0,0.5)';
    e.fillRect(wx + 1, wy + 1, ww - 2, bh);
    e.fillStyle = 'rgba(0,0,0,0.35)';
    for (let y = wy + 2; y < wy + 1 + bh; y += 3) e.fillRect(wx + 1, y, ww - 2, 1);
  } else if (r < 0.5) {
    // Curtains half drawn from one or both sides.
    e.fillStyle = 'rgba(0,0,0,0.62)';
    const cw = (ww - 2) * rng.range(0.15, 0.4);
    e.fillRect(wx + 1, wy + 1, cw, wh - 2);
    if (rng.chance(0.5)) e.fillRect(wx + ww - 1 - cw * 0.8, wy + 1, cw * 0.8, wh - 2);
  } else if (r < 0.58) {
    // A lamp-lit corner: a soft hot spot.
    const hx = wx + ww * rng.range(0.2, 0.8);
    const rg = e.createRadialGradient(hx, wy + wh * 0.45, 1, hx, wy + wh * 0.45, Math.max(ww, wh) * 0.6);
    rg.addColorStop(0, 'rgba(255,255,255,0.5)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    e.fillStyle = rg;
    e.fillRect(wx + 1, wy + 1, ww - 2, wh - 2);
  }
  // Frames and mullions stay dark.
  e.fillStyle = '#000';
  if (style === 'brick' || style === 'stucco' || style === 'house') {
    e.fillRect(wx + ww / 2 - 1.5, wy, 3, wh);
  } else if (style === 'office') {
    for (let k = 0; k < 4; k++) e.fillRect(x0 + (cell / 4) * k, wy, 2, wh);
  }
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

// ---------------------------------------------------------------------------
// Storefront atlas: the street-level ground floors (shops, lobbies, the bank, loading bays and
// house fronts). One 2048x1024 colour canvas and a matching emissive canvas hold 24 cells of
// 256x336 px in three rows of eight, plus a 16 px strip of swatches along the bottom.
// Each cell is drawn for a physical frontage (CELL_DESIGN, in metres) and squeezed into its
// square-ish slot, so text and shapes come out undistorted on a quad of that size.

export const ATLAS_W = 2048;
export const ATLAS_H = 1024;
const ATLAS_COLS = 8;
const CELL_PX_W = 256;
const CELL_PX_H = 336;
const SWATCH_Y = 3 * CELL_PX_H;
const SWATCH_PX_W = 256;
const SWATCH_PX_H = ATLAS_H - SWATCH_Y;
/** Pixels trimmed from every cell edge so mip levels do not bleed in from the neighbours. */
const CELL_INSET = 3;

/** Atlas cells after the 16 shopfronts (cells 0-15). */
export const CELLS = {
  lobbyRevolving: 16,
  lobbyDoors: 17,
  lobbyGlass: 18,
  bank: 19,
  rollup: 20,
  houseDoorA: 21,
  houseDoorB: 22,
  houseWindows: 23,
} as const;
export const SHOP_CELL_COUNT = 16;
export const SWATCHES = { gunFascia: 0 } as const;

/** Frontage (width, height in metres) each kind of cell is drawn for. */
export const CELL_DESIGN = {
  shop: { w: 6.5, h: 4.5 },
  lobby: { w: 6.5, h: 6.5 },
  rollup: { w: 6.5, h: 5 },
  house: { w: 6.5, h: 3 },
} as const;
/** Fraction of a shop cell's height, from the top, taken by the cornice and fascia sign. */
export const SHOP_FASCIA_FRAC = 1.05 / CELL_DESIGN.shop.h;
/** Height (metres) of the bottom of a shop's display windows and awning attachment, from the top of the cell. */
export const SHOP_AWNING_TOP = 1.0;
/** Door centre (fraction of the cell width) of each door cell. */
export const DOOR_U: Readonly<Record<number, number>> = {
  [CELLS.lobbyRevolving]: 0.5,
  [CELLS.lobbyDoors]: 0.5,
  [CELLS.bank]: 0.5,
  [CELLS.houseDoorA]: 0.3,
  [CELLS.houseDoorB]: 0.5,
};
/** A house door's sill stands this far above the bottom of the cell (a porch deck meets it). */
export const HOUSE_SILL = 0.3;

export interface ShopFront {
  name: string;
  tag: string;
  /** Awning fabric colour (packed RGB); -1 when the shop has no awning. */
  awning: number;
  /** More common on the beachfront. */
  beach: boolean;
}

/** UV rectangle [u0, v0, u1, v1] (v0 at the bottom) of an atlas cell, optionally only the part from `fromTop` to `toTop` (fractions of its height). */
export function storefrontUv(cell: number, fromTop = 0, toTop = 1): [number, number, number, number] {
  const col = cell % ATLAS_COLS;
  const row = Math.floor(cell / ATLAS_COLS);
  const x0 = col * CELL_PX_W + CELL_INSET;
  const x1 = (col + 1) * CELL_PX_W - CELL_INSET;
  const yTop = row * CELL_PX_H + Math.max(CELL_INSET, fromTop * CELL_PX_H);
  const yBot = row * CELL_PX_H + Math.min(CELL_PX_H - CELL_INSET, toTop * CELL_PX_H);
  return [x0 / ATLAS_W, 1 - yBot / ATLAS_H, x1 / ATLAS_W, 1 - yTop / ATLAS_H];
}

/** UV rectangle of a solid swatch from the bottom strip. */
export function swatchUv(index: number): [number, number, number, number] {
  const x0 = index * SWATCH_PX_W + CELL_INSET;
  const x1 = (index + 1) * SWATCH_PX_W - CELL_INSET;
  return [x0 / ATLAS_W, 1 - (SWATCH_Y + SWATCH_PX_H - 4) / ATLAS_H, x1 / ATLAS_W, 1 - (SWATCH_Y + 4) / ATLAS_H];
}

const ANTON = 'Anton, Impact, "Arial Black", sans-serif';
const RAJDHANI = 'Rajdhani, "Arial Narrow", sans-serif';

/** Draws in metres (y down from the top of the frontage) into one atlas slot. */
class Painter {
  readonly sx: number;
  readonly sy: number;

  constructor(
    readonly c: CanvasRenderingContext2D,
    readonly x0: number,
    readonly y0: number,
    readonly mw: number,
    readonly mh: number,
    pw = CELL_PX_W,
    ph = CELL_PX_H,
  ) {
    this.sx = pw / mw;
    this.sy = ph / mh;
  }

  x(m: number): number {
    return this.x0 + m * this.sx;
  }

  y(m: number): number {
    return this.y0 + m * this.sy;
  }

  rect(x: number, y: number, w: number, h: number, fill: string | CanvasGradient): void {
    this.c.fillStyle = fill;
    this.c.fillRect(this.x(x), this.y(y), w * this.sx, h * this.sy);
  }

  /** Vertical gradient over a rectangle. */
  vgrad(x: number, y: number, w: number, h: number, stops: ReadonlyArray<readonly [number, string]>): void {
    const g = this.c.createLinearGradient(0, this.y(y), 0, this.y(y + h));
    for (const [t, col] of stops) g.addColorStop(t, col);
    this.rect(x, y, w, h, g);
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, fill: string): void {
    this.c.fillStyle = fill;
    this.c.beginPath();
    this.c.ellipse(this.x(cx), this.y(cy), Math.max(0.5, rx * this.sx), Math.max(0.5, ry * this.sy), 0, 0, Math.PI * 2);
    this.c.fill();
  }

  /** A circle in metres (an ellipse in the squeezed slot). */
  circle(cx: number, cy: number, r: number, fill: string): void {
    this.ellipse(cx, cy, r, r, fill);
  }

  line(xa: number, ya: number, xb: number, yb: number, width: number, stroke: string): void {
    const c = this.c;
    c.strokeStyle = stroke;
    c.lineWidth = Math.max(1, width * this.sy);
    c.beginPath();
    c.moveTo(this.x(xa), this.y(ya));
    c.lineTo(this.x(xb), this.y(yb));
    c.stroke();
  }

  /** Radial glow (for lamps on the emissive canvas). */
  glow(cx: number, cy: number, r: number, color: string): void {
    const c = this.c;
    c.save();
    c.translate(this.x(cx), this.y(cy));
    c.scale(this.sx / this.sy, 1);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, r * this.sy);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(-r * this.sy, -r * this.sy, 2 * r * this.sy, 2 * r * this.sy);
    c.restore();
  }

  /** Text centred at (cx, cy), `h` metres tall, shrunk to fit `maxW` metres. */
  text(t: string, cx: number, cy: number, h: number, font: string, fill: string, maxW: number, weight = '400', blur = 0, blurColor = fill): void {
    const c = this.c;
    const squeeze = this.sx / this.sy;
    let size = h * this.sy;
    c.save();
    c.font = `${weight} ${size}px ${font}`;
    while (c.measureText(t).width * squeeze > maxW * this.sx && size > 6) {
      size *= 0.92;
      c.font = `${weight} ${size}px ${font}`;
    }
    c.translate(this.x(cx), this.y(cy));
    c.scale(squeeze, 1);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = fill;
    if (blur > 0) {
      c.shadowColor = blurColor;
      c.shadowBlur = blur;
    }
    c.fillText(t, 0, 0);
    c.restore();
  }

  /** Small random specks for weathering (cheap stand-in for per-pixel noise). */
  speckle(x: number, y: number, w: number, h: number, rng: Rng, n: number, dark: string, light: string): void {
    for (let i = 0; i < n; i++) {
      this.c.fillStyle = rng.chance(0.5) ? dark : light;
      this.c.fillRect(this.x(x + rng.next() * w), this.y(y + rng.next() * h), rng.range(1, 3), rng.range(1, 2));
    }
  }
}

/** A colour painter and an emissive painter over the same slot. */
interface Pair {
  m: Painter;
  e: Painter;
  rng: Rng;
}

interface ShopDesign extends ShopFront {
  board: string;
  letters: string;
  neon: string;
  trim: string;
  interior: string;
  light: string;
  doorLeft: boolean;
  grille?: boolean;
  /** Fraction of the display window covered by a lowered roll shutter. */
  shutter?: number;
  goods: (p: Pair, x: number, y: number, w: number, h: number) => void;
}

const SHOP_DESIGNS: ShopDesign[] = [
  {
    name: 'DONUTS', tag: 'HOLEY MOLY', awning: 0xe85a9a, beach: false,
    board: '#f6d3e4', letters: '#d62f7a', neon: '#ff5fb0', trim: '#7a3b52', interior: '#f3e2d2', light: '#ffe4c4', doorLeft: true,
    goods: ({ m, e }, x, y, w, h) => {
      for (let row = 0; row < 2; row++) {
        const sy = y + h * (0.55 + row * 0.22);
        m.rect(x + 0.1, sy + 0.12, w - 0.2, 0.05, '#b8a493');
        for (let k = 0; k < 9; k++) {
          const cx = x + 0.35 + ((w - 0.7) * k) / 8;
          m.circle(cx, sy, 0.13, '#c98a4b');
          m.circle(cx, sy - 0.02, 0.1, ['#ff8fc4', '#5b3420', '#fff4e6', '#ffd35c'][(k + row) % 4]!);
          m.circle(cx, sy - 0.01, 0.035, '#f3e2d2');
          e.circle(cx, sy, 0.13, '#3a2a20');
        }
      }
      m.circle(x + w - 0.6, y + 0.55, 0.38, '#ff5fb0');
      m.circle(x + w - 0.6, y + 0.55, 0.15, '#f3e2d2');
      e.circle(x + w - 0.6, y + 0.55, 0.38, '#ff5fb0');
      e.circle(x + w - 0.6, y + 0.55, 0.15, '#000');
    },
  },
  {
    name: 'PAWN', tag: 'CASH 4 YOUR STUFF', awning: -1, beach: false,
    board: '#20352a', letters: '#f2c94c', neon: '#ffd75e', trim: '#2b2b2b', interior: '#cfc6ae', light: '#fff0c8', doorLeft: false, grille: true,
    goods: ({ m, e }, x, y, w, h) => {
      for (let k = 0; k < 3; k++) {
        const gx = x + 0.5 + k * 0.75;
        m.rect(gx - 0.03, y + 0.35, 0.06, 0.9, '#5a3a22');
        m.ellipse(gx, y + 1.35, 0.22, 0.26, ['#b5651d', '#1f1f1f', '#c0392b'][k]!);
        e.ellipse(gx, y + 1.35, 0.22, 0.26, '#201810');
      }
      m.rect(x + w - 1.5, y + 0.4, 1.1, 0.75, '#222');
      m.rect(x + w - 1.42, y + 0.47, 0.94, 0.6, '#3d5a73');
      e.rect(x + w - 1.42, y + 0.47, 0.94, 0.6, '#6f8fb0');
      m.rect(x + 0.2, y + h - 0.55, w - 0.4, 0.4, '#3b2f25');
      for (let k = 0; k < 14; k++) m.circle(x + 0.4 + k * ((w - 0.8) / 13), y + h - 0.42, 0.04, '#f6e27a');
      m.rect(x + 0.25, y + h - 1.0, w * 0.45, 0.06, '#444');
      m.rect(x + 0.35, y + h - 1.1, w * 0.4, 0.05, '#555');
    },
  },
  {
    name: 'LAUNDROMAT', tag: 'SPIN CITY', awning: 0x3c7fd6, beach: false,
    board: '#e9f3ff', letters: '#1f5fbf', neon: '#6fb4ff', trim: '#30475e', interior: '#e8f0f4', light: '#e6f4ff', doorLeft: true,
    goods: ({ m, e }, x, y, w, h) => {
      const n = 4;
      for (let row = 0; row < 2; row++) {
        for (let k = 0; k < n; k++) {
          const bx = x + 0.25 + k * ((w - 0.5) / n);
          const by = y + h * 0.38 + row * 0.82;
          const bw = (w - 0.5) / n - 0.1;
          m.rect(bx, by, bw, 0.72, '#f7f7f5');
          m.rect(bx, by, bw, 0.12, '#cfd6dc');
          m.circle(bx + bw / 2, by + 0.43, 0.22, '#5c6b78');
          m.circle(bx + bw / 2, by + 0.43, 0.16, '#9ec3dd');
          e.rect(bx, by, bw, 0.72, '#2a3036');
        }
      }
    },
  },
  {
    name: 'TACOS', tag: "TACO 'BOUT IT", awning: 0xf28c28, beach: true,
    board: '#ffd23f', letters: '#c0392b', neon: '#ff7a2f', trim: '#7b2d12', interior: '#f4d6a6', light: '#ffd29a', doorLeft: false,
    goods: ({ m, e }, x, y, w, h) => {
      m.rect(x + 0.3, y + 0.25, w * 0.55, 0.9, '#2b2b2b');
      for (let k = 0; k < 5; k++) m.rect(x + 0.42, y + 0.38 + k * 0.15, w * 0.35, 0.05, '#f2f2f2');
      e.rect(x + 0.3, y + 0.25, w * 0.55, 0.9, '#5a4a3a');
      m.ellipse(x + w - 0.85, y + 0.7, 0.45, 0.28, '#f2c14e');
      m.ellipse(x + w - 0.85, y + 0.62, 0.36, 0.12, '#58a83c');
      m.ellipse(x + w - 0.85, y + 0.58, 0.25, 0.07, '#d64534');
      e.ellipse(x + w - 0.85, y + 0.7, 0.45, 0.28, '#ffb347');
      for (let k = 0; k < 10; k++) {
        const lx = x + 0.2 + k * ((w - 0.4) / 9);
        m.circle(lx, y + 0.1, 0.04, ['#ff4136', '#2ecc40', '#ffdc00'][k % 3]!);
        e.circle(lx, y + 0.1, 0.05, ['#ff4136', '#2ecc40', '#ffdc00'][k % 3]!);
      }
      m.rect(x + 0.1, y + h - 0.65, w - 0.2, 0.5, '#8e5a2b');
    },
  },
  {
    name: 'BAIL BONDS', tag: 'OUT BY LUNCH  24/7', awning: -1, beach: false,
    board: '#b3201e', letters: '#ffffff', neon: '#ff3b3b', trim: '#3a3a3a', interior: '#d9d4c7', light: '#fff2d6', doorLeft: true, shutter: 0.3,
    goods: ({ m, e }, x, y, w, h) => {
      for (let k = 0; k < 9; k++) m.rect(x + 0.05, y + h * 0.35 + k * 0.17, w - 0.1, 0.06, '#c9c2b0');
      m.rect(x + w * 0.18, y + h * 0.45, w * 0.64, 0.75, '#fff');
      m.text('24/7', x + w * 0.5, y + h * 0.45 + 0.27, 0.32, ANTON, '#b3201e', w * 0.55);
      m.text('FREE CALL', x + w * 0.5, y + h * 0.45 + 0.58, 0.16, RAJDHANI, '#222', w * 0.55, '700');
      e.text('24/7', x + w * 0.5, y + h * 0.45 + 0.27, 0.32, ANTON, '#ff4444', w * 0.55, '400', 8);
    },
  },
  {
    name: 'SURF SHOP', tag: 'WIPEOUT', awning: 0x19a7a0, beach: true,
    board: '#e6fbf8', letters: '#0f7d78', neon: '#38e1d2', trim: '#2a6f73', interior: '#f6efe0', light: '#fff4dc', doorLeft: false,
    goods: ({ m, e }, x, y, w, h) => {
      const cols = ['#ff6b6b', '#ffd93d', '#4d96ff', '#6bcb77', '#ff9f45', '#c77dff'];
      for (let k = 0; k < 6; k++) {
        const bx = x + 0.35 + k * ((w - 0.7) / 5);
        m.ellipse(bx, y + h * 0.55, 0.16, h * 0.42, cols[k]!);
        m.rect(bx - 0.015, y + h * 0.18, 0.03, h * 0.74, '#ffffff');
        e.ellipse(bx, y + h * 0.55, 0.16, h * 0.42, '#3a3020');
      }
    },
  },
  {
    name: 'ARCADE', tag: 'INSERT COIN', awning: -1, beach: true,
    board: '#1b0f33', letters: '#ff4fd8', neon: '#ff4fd8', trim: '#2a1b4a', interior: '#20163a', light: '#7f5cff', doorLeft: true,
    goods: ({ m, e }, x, y, w, h) => {
      for (let k = 0; k < 4; k++) {
        const cx = x + 0.3 + k * ((w - 0.6) / 4);
        const cw = (w - 0.6) / 4 - 0.15;
        m.rect(cx, y + h * 0.3, cw, h * 0.7, '#111');
        const scr = ['#3cf', '#f3c', '#ff3', '#3f6'][k]!;
        m.rect(cx + 0.06, y + h * 0.35, cw - 0.12, h * 0.22, scr);
        e.rect(cx + 0.06, y + h * 0.35, cw - 0.12, h * 0.22, scr);
        m.rect(cx, y + h * 0.3, cw, 0.08, '#ff4fd8');
        e.rect(cx, y + h * 0.3, cw, 0.08, '#ff4fd8');
      }
    },
  },
  {
    name: 'LIQUOR', tag: 'LIQUID COURAGE', awning: -1, beach: false,
    board: '#1f1f1f', letters: '#ff3b30', neon: '#ff3b30', trim: '#4b1e1e', interior: '#e6dcc5', light: '#fff0cc', doorLeft: false, grille: true,
    goods: ({ m, e }, x, y, w, h) => {
      for (let row = 0; row < 4; row++) {
        const sy = y + 0.3 + row * (h * 0.22);
        m.rect(x + 0.1, sy + 0.42, w - 0.2, 0.05, '#7a6650');
        for (let k = 0; k < 16; k++) {
          const bx = x + 0.2 + k * ((w - 0.4) / 16);
          const col = ['#3b6e2f', '#7a4a1f', '#c9d6df', '#5a1f2c', '#d9a441'][(k * 3 + row) % 5]!;
          m.rect(bx, sy + 0.08, 0.1, 0.34, col);
          m.rect(bx + 0.03, sy, 0.04, 0.1, col);
          e.rect(bx, sy + 0.08, 0.1, 0.34, '#2a2018');
        }
      }
      m.text('COLD BEER', x + w * 0.5, y + h - 0.35, 0.22, ANTON, '#4dd2ff', w * 0.6);
      e.text('COLD BEER', x + w * 0.5, y + h - 0.35, 0.22, ANTON, '#4dd2ff', w * 0.6, '400', 6);
    },
  },
  {
    name: 'PHARMACY', tag: 'SIDE EFFECTS MAY VARY', awning: -1, beach: false,
    board: '#ffffff', letters: '#1b8a3a', neon: '#2ee66b', trim: '#1b5e3a', interior: '#f2f5f2', light: '#f2fff4', doorLeft: true,
    goods: ({ m, e }, x, y, w, h) => {
      for (let row = 0; row < 3; row++) {
        const sy = y + h * 0.42 + row * (h * 0.18);
        m.rect(x + 0.1, sy + 0.32, w - 0.2, 0.04, '#bbb');
        for (let k = 0; k < 12; k++) m.rect(x + 0.2 + k * ((w - 0.4) / 12), sy + 0.08, 0.2, 0.24, ['#e74c3c', '#3498db', '#f1c40f', '#ecf0f1', '#9b59b6'][(k + row) % 5]!);
      }
      const cx = x + w - 0.7;
      const cy = y + 0.6;
      m.rect(cx - 0.35, cy - 0.12, 0.7, 0.24, '#2ee66b');
      m.rect(cx - 0.12, cy - 0.35, 0.24, 0.7, '#2ee66b');
      e.rect(cx - 0.35, cy - 0.12, 0.7, 0.24, '#2ee66b');
      e.rect(cx - 0.12, cy - 0.35, 0.24, 0.7, '#2ee66b');
    },
  },
  {
    name: 'NAILS', tag: 'NAILED IT', awning: 0xc85fa5, beach: false,
    board: '#2d1630', letters: '#ff8ad8', neon: '#ff8ad8', trim: '#5a2d5c', interior: '#fbe3ef', light: '#ffe3f2', doorLeft: false,
    goods: ({ m, e }, x, y, w, h) => {
      for (let k = 0; k < 3; k++) {
        const tx = x + 0.3 + k * ((w - 0.6) / 3);
        m.rect(tx, y + h * 0.7, (w - 0.6) / 3 - 0.2, 0.08, '#fff');
        m.rect(tx + 0.1, y + h * 0.78, 0.06, h * 0.22, '#ccc');
        m.ellipse(tx + 0.4, y + h * 0.6, 0.18, 0.22, '#7b4a8c');
      }
      for (let k = 0; k < 18; k++) m.rect(x + 0.25 + k * ((w - 0.5) / 18), y + 0.35, 0.07, 0.18, ['#ff3b6b', '#c00', '#f9c', '#a0f', '#f60', '#09c'][k % 6]!);
      m.text('OPEN', x + w * 0.7, y + 0.85, 0.28, ANTON, '#ff4fd8', w * 0.4);
      e.text('OPEN', x + w * 0.7, y + 0.85, 0.28, ANTON, '#ff4fd8', w * 0.4, '400', 8);
    },
  },
  {
    name: 'CAFE', tag: 'BEAN THERE', awning: 0x6b3f2a, beach: true,
    board: '#3e2a1f', letters: '#f3e3c3', neon: '#ffd9a0', trim: '#2b1d15', interior: '#e9d8bd', light: '#ffd9a8', doorLeft: true,
    goods: ({ m, e }, x, y, w, h) => {
      for (let k = 0; k < 2; k++) {
        const tx = x + 0.6 + k * (w * 0.45);
        m.ellipse(tx, y + h * 0.66, 0.42, 0.06, '#5a3a24');
        m.rect(tx - 0.03, y + h * 0.66, 0.06, h * 0.32, '#3a2a1f');
        m.rect(tx - 0.55, y + h * 0.6, 0.12, h * 0.38, '#7a5a3a');
        m.rect(tx + 0.43, y + h * 0.6, 0.12, h * 0.38, '#7a5a3a');
        m.circle(tx, y + h * 0.62, 0.06, '#fff');
      }
      m.ellipse(x + w - 0.75, y + 0.65, 0.3, 0.32, '#f3e3c3');
      m.rect(x + w - 1.0, y + 0.45, 0.5, 0.4, '#f3e3c3');
      m.ellipse(x + w - 0.42, y + 0.62, 0.1, 0.12, '#f3e3c3');
      e.rect(x + w - 1.0, y + 0.45, 0.5, 0.4, '#ffcf8a');
      for (let k = 0; k < 5; k++) {
        m.circle(x + 0.4 + k * 0.32, y + 0.25, 0.07, '#fff6dd');
        e.circle(x + 0.4 + k * 0.32, y + 0.25, 0.09, '#fff1c6');
      }
    },
  },
  {
    name: 'PIZZA', tag: 'SLICE SLICE BABY', awning: 0x2f9e44, beach: true,
    board: '#ffffff', letters: '#c92a2a', neon: '#ff4d4d', trim: '#2f6b3a', interior: '#f1dcc0', light: '#ffc98a', doorLeft: false,
    goods: ({ m, e }, x, y, w, h) => {
      m.rect(x + 0.25, y + h * 0.3, w * 0.45, h * 0.5, '#8b3a2a');
      m.ellipse(x + 0.25 + w * 0.225, y + h * 0.62, w * 0.16, h * 0.14, '#1a0d08');
      m.ellipse(x + 0.25 + w * 0.225, y + h * 0.66, w * 0.12, h * 0.08, '#ff7b22');
      e.ellipse(x + 0.25 + w * 0.225, y + h * 0.66, w * 0.14, h * 0.1, '#ff6a00');
      for (let k = 0; k < 3; k++) {
        const px = x + w * 0.62 + k * 0.42;
        m.circle(px, y + h * 0.82, 0.18, '#e8a33d');
        m.circle(px, y + h * 0.82, 0.15, '#d9480f');
        m.circle(px + 0.04, y + h * 0.8, 0.03, '#ffe066');
      }
      m.text('BY THE SLICE', x + w * 0.7, y + 0.4, 0.18, ANTON, '#c92a2a', w * 0.5);
      e.text('BY THE SLICE', x + w * 0.7, y + 0.4, 0.18, ANTON, '#ff6b6b', w * 0.5, '400', 6);
    },
  },
  {
    name: 'VINYL', tag: 'WAX POETIC', awning: -1, beach: false,
    board: '#111111', letters: '#ff9f1c', neon: '#ff9f1c', trim: '#222', interior: '#d8cfc2', light: '#ffe2b8', doorLeft: true,
    goods: ({ m, e }, x, y, w, h) => {
      const cols = ['#e63946', '#457b9d', '#f4a261', '#2a9d8f', '#e9c46a', '#8d5bd1'];
      for (let row = 0; row < 2; row++) {
        for (let k = 0; k < 4; k++) {
          const sx = x + 0.3 + k * ((w - 0.6) / 4);
          const s = (w - 0.6) / 4 - 0.15;
          const sy = y + 0.35 + row * (h * 0.36);
          m.rect(sx, sy, s, s * 0.9, cols[(k + row * 2) % 6]!);
          m.circle(sx + s * 0.62, sy + s * 0.45, s * 0.32, '#111');
          m.circle(sx + s * 0.62, sy + s * 0.45, s * 0.1, '#f1faee');
          e.rect(sx, sy, s, s * 0.9, '#2a2420');
        }
      }
    },
  },
  {
    name: 'PHONES', tag: 'BURNER BROS', awning: -1, beach: false,
    board: '#0f2b5b', letters: '#ffffff', neon: '#4dc3ff', trim: '#14213d', interior: '#eef2f7', light: '#eaf4ff', doorLeft: false,
    goods: ({ m, e }, x, y, w, h) => {
      m.rect(x + 0.15, y + h * 0.72, w - 0.3, 0.1, '#ccd');
      for (let k = 0; k < 8; k++) {
        const px = x + 0.3 + k * ((w - 0.6) / 8);
        m.rect(px, y + h * 0.5, 0.22, 0.4, '#1c1c1c');
        m.rect(px + 0.02, y + h * 0.5 + 0.03, 0.18, 0.32, ['#4dc3ff', '#9b5de5', '#00f5d4', '#fee440'][k % 4]!);
        e.rect(px + 0.02, y + h * 0.5 + 0.03, 0.18, 0.32, ['#4dc3ff', '#9b5de5', '#00f5d4', '#fee440'][k % 4]!);
      }
      m.rect(x + 0.4, y + 0.3, w * 0.5, 0.7, '#0f2b5b');
      m.text('UNLOCKED', x + 0.4 + w * 0.25, y + 0.55, 0.2, ANTON, '#fff', w * 0.45);
      m.text('NO QUESTIONS', x + 0.4 + w * 0.25, y + 0.82, 0.12, RAJDHANI, '#4dc3ff', w * 0.45, '700');
    },
  },
  {
    name: 'TATTOO', tag: 'REGRET INK', awning: -1, beach: true,
    board: '#151515', letters: '#e5383b', neon: '#e5383b', trim: '#3d0c11', interior: '#cfc3b5', light: '#ffd7c2', doorLeft: true, shutter: 0.18,
    goods: ({ m, e }, x, y, w, h) => {
      for (let k = 0; k < 6; k++) {
        const fx = x + 0.3 + (k % 3) * ((w - 0.6) / 3);
        const fy = y + h * 0.35 + Math.floor(k / 3) * (h * 0.3);
        const s = (w - 0.6) / 3 - 0.2;
        m.rect(fx, fy, s, h * 0.24, '#f5efe6');
        m.circle(fx + s * 0.5, fy + h * 0.1, s * 0.22, ['#e5383b', '#1d3557', '#2a9d8f'][k % 3]!);
        m.rect(fx + s * 0.2, fy + h * 0.17, s * 0.6, 0.05, '#222');
      }
      m.text('OPEN', x + w * 0.5, y + h - 0.3, 0.24, ANTON, '#e5383b', w * 0.4);
      e.text('OPEN', x + w * 0.5, y + h - 0.3, 0.24, ANTON, '#ff3b3b', w * 0.4, '400', 8);
    },
  },
  {
    name: 'DELI', tag: 'HERO WORSHIP', awning: 0x1e7b46, beach: false,
    board: '#f4f1e8', letters: '#1e5631', neon: '#5adf8a', trim: '#1e5631', interior: '#f3ead8', light: '#fff1d6', doorLeft: false,
    goods: ({ m, e }, x, y, w, h) => {
      for (let k = 0; k < 7; k++) {
        const sx = x + 0.4 + k * ((w - 0.8) / 6);
        m.line(sx, y + 0.1, sx, y + 0.35, 0.02, '#555');
        m.ellipse(sx, y + 0.6, 0.09, 0.26, k % 2 ? '#8b2e1f' : '#a0522d');
        e.ellipse(sx, y + 0.6, 0.09, 0.26, '#201510');
      }
      m.rect(x + 0.1, y + h * 0.62, w - 0.2, h * 0.38, '#fafafa');
      m.rect(x + 0.2, y + h * 0.66, w - 0.4, h * 0.14, '#cfe8f3');
      for (let k = 0; k < 6; k++) m.circle(x + 0.5 + k * ((w - 1) / 5), y + h * 0.73, 0.12, ['#f6c343', '#d1495b', '#edae49', '#f2e8cf'][k % 4]!);
    },
  },
];

export const SHOPS: readonly ShopFront[] = SHOP_DESIGNS.map(({ name, tag, awning, beach }) => ({ name, tag, awning, beach }));

function drawShop(p: Pair, d: ShopDesign): void {
  const { m, e } = p;
  const W = CELL_DESIGN.shop.w;
  const H = CELL_DESIGN.shop.h;
  // Piers, cornice and fascia board.
  m.rect(0, 0, W, H, d.trim);
  m.rect(0, 0, W, 0.1, '#2a2a2a');
  m.rect(0.12, 0.1, W - 0.24, 0.85, d.board);
  m.rect(0.12, 0.1, W - 0.24, 0.04, 'rgba(255,255,255,0.25)');
  m.rect(0.12, 0.91, W - 0.24, 0.04, 'rgba(0,0,0,0.25)');
  m.text(d.name, W / 2, 0.45, 0.5, ANTON, d.letters, W - 0.9);
  m.text(d.tag, W / 2, 0.8, 0.15, RAJDHANI, d.letters, W - 1.2, '700');
  e.text(d.name, W / 2, 0.45, 0.5, ANTON, d.neon, W - 0.9, '400', 10, d.neon);
  e.text(d.tag, W / 2, 0.8, 0.15, RAJDHANI, d.neon, W - 1.2, '700');
  // Door and display window.
  const doorX = d.doorLeft ? 0.5 : W - 1.5;
  const winX = d.doorLeft ? 1.75 : 0.45;
  const winW = W - 2.2;
  const winY = SHOP_AWNING_TOP + 0.15;
  const winH = 2.55;
  // Interior seen through the glass, then the goods, then reflections.
  m.vgrad(winX, winY, winW, winH, [
    [0, '#f8f4ea'],
    [0.12, d.interior],
    [1, d.interior],
  ]);
  e.vgrad(winX, winY, winW, winH, [
    [0, d.light],
    [0.15, d.light],
    [1, '#4a4038'],
  ]);
  d.goods(p, winX, winY, winW, winH);
  m.rect(winX + winW / 2 - 0.04, winY, 0.08, winH, d.trim);
  e.rect(winX + winW / 2 - 0.04, winY, 0.08, winH, '#000');
  // Bulkhead under the window.
  m.rect(winX - 0.05, winY + winH, winW + 0.1, H - winY - winH, '#2f2f33');
  m.rect(winX - 0.05, winY + winH, winW + 0.1, 0.06, '#55555c');
  // Door: glass with a frame and a transom.
  m.rect(doorX, winY, 1.0, 0.55, '#1e2a33');
  e.rect(doorX + 0.06, winY + 0.06, 0.88, 0.43, d.light);
  m.rect(doorX + 0.06, winY + 0.06, 0.88, 0.43, '#6d8597');
  const dy = winY + 0.6;
  m.rect(doorX, dy, 1.0, H - dy - 0.04, '#1e2a33');
  m.vgrad(doorX + 0.09, dy + 0.08, 0.82, H - dy - 0.3, [
    [0, '#9fb3c2'],
    [1, '#4f6271'],
  ]);
  e.vgrad(doorX + 0.09, dy + 0.08, 0.82, H - dy - 0.3, [
    [0, d.light],
    [1, '#3a3530'],
  ]);
  m.rect(doorX + 0.12, dy + 1.1, 0.76, 0.05, '#c8c8c8');
  m.rect(doorX + (d.doorLeft ? 0.78 : 0.12), dy + 1.0, 0.06, 0.3, '#ddd');
  // Glass reflections (daytime only: the colour map).
  for (const [gx, gw] of [
    [winX, winW],
    [doorX + 0.09, 0.82],
  ] as const) {
    const c = m.c;
    c.fillStyle = 'rgba(255,255,255,0.13)';
    c.beginPath();
    c.moveTo(m.x(gx + gw * 0.1), m.y(winY));
    c.lineTo(m.x(gx + gw * 0.42), m.y(winY));
    c.lineTo(m.x(gx + gw * 0.18), m.y(winY + winH));
    c.lineTo(m.x(gx), m.y(winY + winH));
    c.closePath();
    c.fill();
  }
  if (d.shutter) {
    const sh = winH * d.shutter;
    for (let y = 0; y < sh; y += 0.09) m.rect(winX, winY + y, winW, 0.05, '#9aa1a8');
    m.rect(winX, winY, winW, sh, 'rgba(110,116,122,0.45)');
    m.rect(winX - 0.05, winY + sh - 0.06, winW + 0.1, 0.08, '#555b61');
    e.rect(winX, winY, winW, sh, '#000');
  }
  if (d.grille) {
    for (let x = winX + 0.1; x < winX + winW; x += 0.18) {
      m.rect(x, winY, 0.035, winH, '#3a3a3a');
      e.rect(x, winY, 0.035, winH, '#000');
    }
    m.rect(winX, winY + winH * 0.33, winW, 0.03, '#3a3a3a');
    m.rect(winX, winY + winH * 0.66, winW, 0.03, '#3a3a3a');
  }
  m.speckle(0, 1.0, W, H - 1.0, p.rng, 260, 'rgba(0,0,0,0.12)', 'rgba(255,255,255,0.07)');
  // Threshold.
  m.rect(0, H - 0.05, W, 0.05, '#4b4b4b');
}

function lobbyBase(p: Pair, wall: string): { W: number; H: number } {
  const { m, e } = p;
  const W = CELL_DESIGN.lobby.w;
  const H = CELL_DESIGN.lobby.h;
  m.rect(0, 0, W, H, '#2c3138');
  // Interior behind tinted glass: by day the glass reads mostly by its reflections.
  m.vgrad(0.15, 0.4, W - 0.3, H - 0.45, [
    [0, '#9c978e'],
    [0.12, wall],
    [0.85, '#6f6a62'],
    [1, '#55524d'],
  ]);
  // A softly lit interior: bright downlights, the walls in their warm spill.
  e.vgrad(0.15, 0.4, W - 0.3, H - 0.45, [
    [0, '#6a5c46'],
    [0.3, '#3a332a'],
    [0.85, '#211e1a'],
    [1, '#100f0d'],
  ]);
  for (let k = 0; k < 4; k++) {
    const lx = 0.5 + k * ((W - 1) / 3);
    m.rect(lx - 0.35, 0.45, 0.7, 0.08, '#fffbe8');
    e.rect(lx - 0.35, 0.45, 0.7, 0.08, '#ffffff');
    e.glow(lx, 0.7, 0.8, 'rgba(255,236,200,0.3)');
  }
  // Head band.
  m.rect(0, 0, W, 0.38, '#3a4048');
  m.rect(0, 0.34, W, 0.04, '#5b636d');
  return { W, H };
}

function lobbyMullions(p: Pair, W: number, H: number): void {
  const { m, e } = p;
  for (const x of [0.15, 1.7, W - 1.7, W - 0.15]) {
    m.rect(x - 0.05, 0.38, 0.1, H - 0.38, '#2c3138');
    e.rect(x - 0.05, 0.38, 0.1, H - 0.38, '#000');
  }
  m.rect(0, 3.15, W, 0.07, '#2c3138');
  e.rect(0, 3.15, W, 0.07, '#000');
  // Sky reflection on the glass.
  const c = m.c;
  c.fillStyle = 'rgba(200,225,255,0.16)';
  c.beginPath();
  c.moveTo(m.x(0.3), m.y(0.4));
  c.lineTo(m.x(2.6), m.y(0.4));
  c.lineTo(m.x(0.9), m.y(H));
  c.lineTo(m.x(0.15), m.y(H));
  c.closePath();
  c.fill();
  m.rect(0, H - 0.08, W, 0.08, '#3d4148');
}

function plant(p: Pair, x: number, floor: number): void {
  p.m.rect(x - 0.2, floor - 0.45, 0.4, 0.45, '#5a4636');
  p.m.circle(x, floor - 0.85, 0.42, '#2f6b35');
  p.m.circle(x - 0.2, floor - 1.12, 0.26, '#3e8a45');
  p.m.circle(x + 0.2, floor - 1.08, 0.24, '#357a3d');
  p.e.circle(x, floor - 0.9, 0.42, '#14140f');
  p.e.rect(x - 0.2, floor - 0.45, 0.4, 0.45, '#14140f');
}

function drawLobbyRevolving(p: Pair): void {
  const { W, H } = lobbyBase(p, '#8f897d');
  const { m, e } = p;
  // Reception desk and plants behind the glass.
  m.rect(4.6, H - 1.2, 1.4, 1.1, '#4a3628');
  m.rect(4.6, H - 1.25, 1.4, 0.08, '#d8c9a8');
  e.rect(4.6, H - 1.2, 1.4, 1.1, '#18120e');
  plant(p, 0.85, H - 0.1);
  lobbyMullions(p, W, H);
  // Revolving door drum.
  const cx = W / 2;
  m.rect(cx - 1.3, H - 3.05, 2.6, 0.28, '#23272d');
  m.rect(cx - 1.3, H - 3.05, 2.6, 0.05, '#7d8794');
  m.vgrad(cx - 1.2, H - 2.77, 2.4, 2.72, [
    [0, 'rgba(190,210,225,0.55)'],
    [1, 'rgba(90,105,120,0.55)'],
  ]);
  for (const x of [cx - 1.2, cx - 0.55, cx, cx + 0.55, cx + 1.2]) {
    m.rect(x - 0.035, H - 2.77, 0.07, 2.72, '#2c3138');
    e.rect(x - 0.035, H - 2.77, 0.07, 2.72, '#000');
  }
  m.rect(cx - 1.2, H - 1.5, 2.4, 0.05, '#9aa4ae');
}

function drawLobbyDoors(p: Pair): void {
  const { W, H } = lobbyBase(p, '#8b8579');
  const { m, e } = p;
  plant(p, 0.9, H - 0.1);
  plant(p, W - 0.9, H - 0.1);
  m.rect(2.6, H - 2.3, 1.3, 0.45, '#3a2f28');
  lobbyMullions(p, W, H);
  // Stone surround with double glass doors.
  const cx = W / 2;
  m.rect(cx - 1.25, H - 3.1, 2.5, 3.1, '#bdb6aa');
  m.rect(cx - 1.25, H - 3.1, 2.5, 0.1, '#d8d2c6');
  m.rect(cx - 0.95, H - 2.8, 1.9, 2.8, '#1e2329');
  for (const x of [cx - 0.9, cx + 0.03]) {
    m.vgrad(x, H - 2.72, 0.87, 2.64, [
      [0, '#a9bccb'],
      [1, '#56697a'],
    ]);
    e.vgrad(x, H - 2.72, 0.87, 2.64, [
      [0, '#ffe9c4'],
      [1, '#5a5040'],
    ]);
    m.rect(x + 0.1, H - 1.45, 0.67, 0.05, '#c9cfd4');
  }
  m.text('1200', cx, H - 2.95, 0.12, RAJDHANI, '#2a2a2a', 1.2, '700');
}

function drawLobbyGlass(p: Pair): void {
  const { W, H } = lobbyBase(p, '#8d877d');
  const { m, e } = p;
  // A quiet stretch of lobby: slatted back wall, a low bench and one plant (mirrored on alternate quads).
  for (let x = 0.5; x < W - 0.3; x += 0.32) m.rect(x, 1.2, 0.05, H - 2.1, 'rgba(120,96,70,0.18)');
  m.rect(1.4, H - 0.85, 2.6, 0.32, '#3d3a36');
  m.rect(1.55, H - 0.53, 0.12, 0.45, '#2a2724');
  m.rect(3.73, H - 0.53, 0.12, 0.45, '#2a2724');
  e.rect(1.4, H - 0.85, 2.6, 0.75, '#141210');
  plant(p, W - 1.1, H - 0.1);
  lobbyMullions(p, W, H);
}

function drawBank(p: Pair): void {
  const { m, e, rng } = p;
  const W = CELL_DESIGN.lobby.w;
  const H = CELL_DESIGN.lobby.h;
  m.rect(0, 0, W, H, '#d6ccb7');
  for (let y = 0.9; y < H; y += 0.5) m.rect(0, y, W, 0.035, '#b3a990');
  m.speckle(0, 0, W, H, rng, 400, 'rgba(90,80,60,0.15)', 'rgba(255,255,255,0.12)');
  // Entablature with dentils.
  m.rect(0, 0, W, 0.85, '#e4dbc8');
  m.rect(0, 0.78, W, 0.07, '#a89e86');
  for (let x = 0.1; x < W; x += 0.28) m.rect(x, 0.62, 0.14, 0.14, '#c9bfa8');
  // Pilasters.
  for (const x of [0.35, W - 1.0]) {
    m.rect(x, 0.85, 0.65, H - 0.85, '#e7dfcd');
    m.rect(x - 0.08, 0.85, 0.81, 0.28, '#d2c8b2');
    m.rect(x - 0.08, H - 0.45, 0.81, 0.45, '#cfc5ae');
    for (let k = 1; k < 4; k++) m.rect(x + k * 0.16, 1.2, 0.03, H - 1.7, '#cdc3ad');
  }
  // Recessed entrance: transom and bronze doors.
  m.rect(1.55, 1.35, W - 3.1, H - 1.35, '#5b5346');
  m.rect(1.8, 1.55, W - 3.6, 1.05, '#2a2f35');
  m.vgrad(1.88, 1.62, W - 3.76, 0.9, [
    [0, '#c4d3dc'],
    [1, '#6f8291'],
  ]);
  e.rect(1.88, 1.62, W - 3.76, 0.9, '#ffe2a8');
  for (let k = 1; k < 4; k++) m.rect(1.88 + (k * (W - 3.76)) / 4, 1.62, 0.04, 0.9, '#2a2f35');
  const dTop = 2.8;
  m.vgrad(1.85, dTop, W - 3.7, H - dTop, [
    [0, '#8a6a3a'],
    [1, '#4e3a1f'],
  ]);
  m.rect(W / 2 - 0.03, dTop, 0.06, H - dTop, '#2e2414');
  for (const x of [1.95, W / 2 + 0.1]) {
    for (let k = 0; k < 3; k++) m.rect(x, dTop + 0.15 + k * 1.15, W / 2 - 2.05, 0.95, 'rgba(255,220,160,0.12)');
  }
  e.rect(1.85, dTop, W - 3.7, H - dTop, '#000');
  // Lanterns either side of the doors.
  for (const x of [1.25, W - 1.25]) {
    m.rect(x - 0.12, 3.0, 0.24, 0.42, '#2d2a24');
    m.rect(x - 0.09, 3.05, 0.18, 0.3, '#fff2c4');
    e.rect(x - 0.09, 3.05, 0.18, 0.3, '#ffffff');
    e.glow(x, 3.2, 0.9, 'rgba(255,220,160,0.55)');
  }
  m.rect(0, H - 0.12, W, 0.12, '#b8ae98');
}

function drawRollup(p: Pair): void {
  const { m, e, rng } = p;
  const W = CELL_DESIGN.rollup.w;
  const H = CELL_DESIGN.rollup.h;
  m.rect(0, 0, W, H, '#9b9990');
  m.speckle(0, 0, W, H, rng, 700, 'rgba(40,40,40,0.18)', 'rgba(255,255,255,0.1)');
  for (let k = 0; k < 6; k++) m.rect(rng.range(0, W), 0, rng.range(0.05, 0.2), rng.range(0.6, 2.2), 'rgba(70,60,50,0.12)');
  // Roll-up door with its housing, frame and guards.
  const dx = 0.5;
  const dw = 4.4;
  const dt = 0.9;
  m.rect(dx - 0.15, dt - 0.4, dw + 0.3, 0.4, '#5c6168');
  m.rect(dx - 0.12, dt, 0.12, H - dt, '#44494f');
  m.rect(dx + dw, dt, 0.12, H - dt, '#44494f');
  for (let y = dt; y < H - 0.05; y += 0.11) {
    m.rect(dx, y, dw, 0.06, '#94a1ae');
    m.rect(dx, y + 0.06, dw, 0.05, '#7a8693');
  }
  m.rect(dx, H - 0.14, dw, 0.1, '#3b3f44');
  m.rect(dx + dw / 2 - 0.2, H - 0.45, 0.4, 0.06, '#2a2d31');
  m.text('07', dx + dw / 2, dt + 0.75, 0.6, ANTON, 'rgba(20,20,20,0.75)', 1.2);
  for (const gx of [dx - 0.3, dx + dw + 0.12]) {
    for (let k = 0; k < 6; k++) m.rect(gx, H - 1.1 + k * 0.18, 0.18, 0.09, k % 2 ? '#1c1c1c' : '#f2c230');
  }
  // Personnel door and its lamp.
  const px = 5.4;
  m.rect(px - 0.06, H - 2.2, 0.98, 2.2, '#3c4044');
  m.rect(px, H - 2.14, 0.86, 2.14, '#3e5c4a');
  m.rect(px + 0.25, H - 1.95, 0.36, 0.32, '#9fb6c4');
  m.rect(px + 0.68, H - 1.15, 0.08, 0.12, '#c8c8c8');
  m.rect(px + 0.28, H - 2.75, 0.3, 0.2, '#2c2c2c');
  m.rect(px + 0.31, H - 2.72, 0.24, 0.12, '#fff6d8');
  e.rect(px + 0.31, H - 2.72, 0.24, 0.12, '#ffffff');
  e.glow(px + 0.43, H - 2.4, 1.6, 'rgba(255,214,150,0.55)');
  e.rect(px + 0.25, H - 1.95, 0.36, 0.32, '#806a48');
}

function houseWall(p: Pair): { W: number; H: number } {
  const { m, rng } = p;
  const W = CELL_DESIGN.house.w;
  const H = CELL_DESIGN.house.h;
  // Same base colour as the 'house' facade so the building tint matches above and below.
  m.rect(0, 0, W, H, '#efe5d6');
  m.speckle(0, 0, W, H, rng, 500, 'rgba(60,50,40,0.06)', 'rgba(255,255,255,0.08)');
  m.rect(0, H - HOUSE_SILL, W, HOUSE_SILL, '#a39b8e');
  m.rect(0, H - HOUSE_SILL, W, 0.04, '#8a8276');
  return { W, H };
}

function houseWindow(p: Pair, x: number, w: number, top: number, h: number, curtain: number): void {
  const { m, e } = p;
  m.rect(x - 0.42, top - 0.05, 0.36, h + 0.1, '#3f5d4a');
  m.rect(x + w + 0.06, top - 0.05, 0.36, h + 0.1, '#3f5d4a');
  for (let k = 0; k < 6; k++) {
    m.rect(x - 0.38, top + 0.08 + k * (h / 6), 0.28, 0.03, '#2f4a3a');
    m.rect(x + w + 0.1, top + 0.08 + k * (h / 6), 0.28, 0.03, '#2f4a3a');
  }
  m.rect(x - 0.06, top - 0.06, w + 0.12, h + 0.12, '#fbfaf6');
  m.vgrad(x, top, w, h, [
    [0, '#8fa9bd'],
    [1, '#3e5163'],
  ]);
  e.vgrad(x, top, w, h, [
    [0, '#ffe6b8'],
    [1, '#a8875a'],
  ]);
  if (curtain > 0) {
    m.rect(x, top, w * curtain, h, '#c9a27e');
    m.rect(x + w * (1 - curtain), top, w * curtain, h, '#c9a27e');
    e.rect(x, top, w * curtain, h, '#4a3420');
    e.rect(x + w * (1 - curtain), top, w * curtain, h, '#4a3420');
  }
  m.rect(x + w / 2 - 0.03, top, 0.06, h, '#fbfaf6');
  m.rect(x, top + h / 2 - 0.03, w, 0.06, '#fbfaf6');
  e.rect(x + w / 2 - 0.03, top, 0.06, h, '#000');
  e.rect(x, top + h / 2 - 0.03, w, 0.06, '#000');
  // Flower box.
  m.rect(x - 0.08, top + h + 0.06, w + 0.16, 0.18, '#7a4e2d');
  for (let k = 0; k < 8; k++) m.circle(x + (k + 0.5) * (w / 8), top + h + 0.04, 0.06, ['#e63946', '#f4a261', '#e9c46a', '#ff70a6'][k % 4]!);
}

function houseDoor(p: Pair, cx: number, color: string, sidelights: boolean): void {
  const { m, e } = p;
  const H = CELL_DESIGN.house.h;
  const top = H - HOUSE_SILL - 2.1;
  m.rect(cx - 0.62, top - 0.12, 1.24, 2.1 + 0.12, '#fbfaf6');
  if (sidelights) {
    for (const sx of [cx - 0.78, cx + 0.56]) {
      m.rect(sx, top, 0.22, 2.1, '#fbfaf6');
      m.vgrad(sx + 0.04, top + 0.05, 0.14, 2.0, [
        [0, '#9fb6c8'],
        [1, '#4b5f70'],
      ]);
      e.rect(sx + 0.04, top + 0.05, 0.14, 2.0, '#d9b47a');
    }
  }
  m.rect(cx - 0.5, top, 1.0, 2.1, color);
  for (let k = 0; k < 3; k++) {
    m.rect(cx - 0.36 + k * 0.26, top + 0.14, 0.2, 0.3, '#a9c0d0');
    e.rect(cx - 0.36 + k * 0.26, top + 0.14, 0.2, 0.3, '#ffd99a');
  }
  m.rect(cx - 0.38, top + 0.65, 0.76, 0.6, 'rgba(0,0,0,0.12)');
  m.rect(cx - 0.38, top + 1.35, 0.76, 0.6, 'rgba(0,0,0,0.12)');
  m.circle(cx + 0.36, top + 1.1, 0.04, '#d4af37');
}

function porchLamp(p: Pair, x: number): void {
  const H = CELL_DESIGN.house.h;
  const y = H - HOUSE_SILL - 1.75;
  p.m.rect(x - 0.08, y - 0.14, 0.16, 0.3, '#2a2a2a');
  p.m.rect(x - 0.06, y - 0.1, 0.12, 0.2, '#fff1c4');
  p.e.rect(x - 0.06, y - 0.1, 0.12, 0.2, '#ffffff');
  p.e.glow(x, y, 0.7, 'rgba(255,214,150,0.6)');
}

function drawHouseDoorA(p: Pair): void {
  const { W } = houseWall(p);
  const cx = W * (DOOR_U[CELLS.houseDoorA] ?? 0.3);
  houseDoor(p, cx, '#7a3b2e', false);
  porchLamp(p, cx + 0.85);
  houseWindow(p, 3.85, 1.7, 0.75, 1.25, 0.18);
}

function drawHouseDoorB(p: Pair): void {
  const { W } = houseWall(p);
  const cx = W * (DOOR_U[CELLS.houseDoorB] ?? 0.5);
  houseDoor(p, cx, '#2f4a6b', true);
  porchLamp(p, cx - 1.0);
  houseWindow(p, 0.75, 1.2, 0.8, 1.2, 0);
  houseWindow(p, W - 1.95, 1.2, 0.8, 1.2, 0.22);
}

function drawHouseWindows(p: Pair): void {
  const { W } = houseWall(p);
  houseWindow(p, 0.95, 1.55, 0.75, 1.3, 0.2);
  houseWindow(p, W - 2.5, 1.55, 0.75, 1.3, 0);
}

function drawSwatches(m: CanvasRenderingContext2D, e: CanvasRenderingContext2D): void {
  // Gun shop fascia: a plain dark board under the big BANG BANG GUNS sign.
  const x = SWATCHES.gunFascia * SWATCH_PX_W;
  m.fillStyle = '#1c1c22';
  m.fillRect(x, SWATCH_Y, SWATCH_PX_W, SWATCH_PX_H);
  m.fillStyle = '#ff8a1f';
  m.fillRect(x, SWATCH_Y + 5, SWATCH_PX_W, 1);
  m.fillRect(x, SWATCH_Y + SWATCH_PX_H - 6, SWATCH_PX_W, 1);
  e.fillStyle = '#ff8a1f';
  e.fillRect(x, SWATCH_Y + 5, SWATCH_PX_W, 1);
  e.fillRect(x, SWATCH_Y + SWATCH_PX_H - 6, SWATCH_PX_W, 1);
}

export interface StorefrontAtlas {
  map: THREE.Texture;
  emissive: THREE.Texture;
}

/** Colour and emissive atlas of every ground-floor frontage. */
export function storefrontAtlas(): StorefrontAtlas {
  const [cm, m] = canvas(ATLAS_W, ATLAS_H);
  const [ce, e] = canvas(ATLAS_W, ATLAS_H);
  m.fillStyle = '#808080';
  m.fillRect(0, 0, ATLAS_W, ATLAS_H);
  e.fillStyle = '#000';
  e.fillRect(0, 0, ATLAS_W, ATLAS_H);
  const rng = new Rng(2024);
  const paint = (cell: number, design: { w: number; h: number }, draw: (p: Pair) => void): void => {
    const x0 = (cell % ATLAS_COLS) * CELL_PX_W;
    const y0 = Math.floor(cell / ATLAS_COLS) * CELL_PX_H;
    // Keep every cell's drawing inside its own slot.
    for (const c of [m, e]) {
      c.save();
      c.beginPath();
      c.rect(x0, y0, CELL_PX_W, CELL_PX_H);
      c.clip();
    }
    draw({ m: new Painter(m, x0, y0, design.w, design.h), e: new Painter(e, x0, y0, design.w, design.h), rng });
    m.restore();
    e.restore();
  };
  SHOP_DESIGNS.forEach((d, i) => paint(i, CELL_DESIGN.shop, (p) => drawShop(p, d)));
  paint(CELLS.lobbyRevolving, CELL_DESIGN.lobby, drawLobbyRevolving);
  paint(CELLS.lobbyDoors, CELL_DESIGN.lobby, drawLobbyDoors);
  paint(CELLS.lobbyGlass, CELL_DESIGN.lobby, drawLobbyGlass);
  paint(CELLS.bank, CELL_DESIGN.lobby, drawBank);
  paint(CELLS.rollup, CELL_DESIGN.rollup, drawRollup);
  paint(CELLS.houseDoorA, CELL_DESIGN.house, drawHouseDoorA);
  paint(CELLS.houseDoorB, CELL_DESIGN.house, drawHouseDoorB);
  paint(CELLS.houseWindows, CELL_DESIGN.house, drawHouseWindows);
  drawSwatches(m, e);
  const map = toTexture(cm, true, false);
  const emissive = toTexture(ce, true, false);
  return { map, emissive };
}
