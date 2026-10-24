// Procedurally generated canvas textures: building facades.

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { FacadeStyle } from '../../world/layout';
import { canvas, toTexture, noise, normalFromHeight } from './misc';

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

export interface FacadeTextures {
  map: THREE.Texture;
  emissive: THREE.Texture;
  rough: THREE.Texture;
  normal: THREE.Texture;
}

/** Window grid facade textures: colour, lit-window mask, roughness and actual surface relief. */
export function facadeTextures(style: FacadeStyle, seed: number): FacadeTextures {
  const S = 512;
  const cell = S / FACADE_COLS;
  const rng = new Rng(seed);
  // Keep decor independent of the original emissive-mask stream, so day improvements do not
  // rearrange the inhabited windows at night.
  const decor = new Rng(seed ^ 0x6a09e667);
  const [cm, m] = canvas(S, S);
  const [ce, e] = canvas(S, S);
  const [cr, r] = canvas(S, S);
  const [ch, h] = canvas(S, S);
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
  h.fillStyle = '#808080';
  h.fillRect(0, 0, S, S);
  noise(h, S, S, new Rng(seed ^ 0x3c6ef372), style === 'brick' ? 9 : 4, 1);

  if (style === 'brick') {
    // Brick courses.
    h.strokeStyle = '#626262';
    h.lineWidth = 1.5;
    m.strokeStyle = 'rgba(40,20,15,0.35)';
    m.lineWidth = 1;
    for (let y = 0; y < S; y += 8) {
      m.beginPath();
      m.moveTo(0, y + 0.5);
      m.lineTo(S, y + 0.5);
      m.stroke();
      h.beginPath();
      h.moveTo(0, y + 0.5);
      h.lineTo(S, y + 0.5);
      h.stroke();
      for (let x = (y / 8) % 2 === 0 ? 0 : 8; x < S; x += 16) {
        m.fillStyle = decor.chance(0.5) ? `rgba(210,160,120,${decor.range(0.02, 0.12)})` : `rgba(30,20,16,${decor.range(0.02, 0.1)})`;
        m.fillRect(x + 1, y + 1, 14, 6);
        m.beginPath();
        m.moveTo(x + 0.5, y);
        m.lineTo(x + 0.5, y + 8);
        m.stroke();
        h.beginPath();
        h.moveTo(x + 0.5, y);
        h.lineTo(x + 0.5, y + 8);
        h.stroke();
      }
    }
  } else if (style === 'warehouse') {
    for (let x = 0; x < S; x += 8) {
      m.fillStyle = x % 16 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.12)';
      m.fillRect(x, 0, 4, S);
      h.fillStyle = x % 16 === 0 ? '#929292' : '#747474';
      h.fillRect(x, 0, 4, S);
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
      // Recess and runoff live on the opaque wall. Glazing below stays perfectly planar.
      m.fillStyle = 'rgba(23,30,35,0.22)';
      m.fillRect(wx - 2, wy - 2, ww + 4, wh + 5);
      if (style !== 'glassBlue' && style !== 'glassTeal' && decor.chance(0.7)) {
        const stain = m.createLinearGradient(0, wy + wh, 0, Math.min(y0 + cell, wy + wh + 13));
        stain.addColorStop(0, 'rgba(56,48,35,0.14)');
        stain.addColorStop(1, 'rgba(56,48,35,0)');
        m.fillStyle = stain;
        m.fillRect(wx - 2, wy + wh, ww + 4, Math.min(13, y0 + cell - wy - wh));
      }
      h.fillStyle = '#626262';
      h.fillRect(wx - 1, wy - 1, ww + 2, wh + 2);
      m.fillStyle = glassGrad(wx, wy, ww, wh, glassTop, glassBottom);
      m.fillRect(wx, wy, ww, wh);
      h.fillStyle = '#686868';
      h.fillRect(wx, wy, ww, wh);
      // Independent panes, partially drawn blinds and soft room silhouettes make whole
      // buildings feel occupied without painting fake relief into the reflective glass.
      m.fillStyle = decor.chance(0.35) ? `rgba(197,178,144,${decor.range(0.04, 0.19)})` : `rgba(10,27,38,${decor.range(0.02, 0.27)})`;
      m.fillRect(wx, wy, ww, wh);
      if (decor.chance(0.48)) {
        const blindHeight = Math.floor(wh * decor.range(0.15, 0.72));
        m.fillStyle = 'rgba(187,185,165,0.20)';
        m.fillRect(wx + 2, wy + 1, Math.max(1, ww - 4), blindHeight);
        m.fillStyle = 'rgba(25,36,39,0.20)';
        for (let by = wy + 3; by < wy + blindHeight; by += 3) m.fillRect(wx + 2, by, Math.max(1, ww - 4), 1);
      } else if (decor.chance(0.38)) {
        m.fillStyle = 'rgba(6,17,26,0.22)';
        m.fillRect(wx + ww * 0.14, wy + wh * 0.55, ww * decor.range(0.2, 0.5), wh * 0.45);
      }
      const paneRoughness = style === 'glassBlue' || style === 'glassTeal' ? decor.int(42, 65) : decor.int(75, 100);
      r.fillStyle = `rgb(${paneRoughness},${paneRoughness},${paneRoughness})`;
      r.fillRect(wx, wy, ww, wh);
      // Mullions / frames.
      if (style === 'brick' || style === 'stucco' || style === 'house') {
        m.strokeStyle = style === 'brick' ? '#e8e2d4' : '#ffffff';
        m.lineWidth = 3;
        m.strokeRect(wx, wy, ww, wh);
        m.beginPath();
        m.moveTo(wx + ww / 2, wy);
        m.lineTo(wx + ww / 2, wy + wh);
        m.stroke();
        h.strokeStyle = '#a0a0a0';
        h.lineWidth = 3;
        h.strokeRect(wx, wy, ww, wh);
        h.fillStyle = '#989898';
        h.fillRect(wx + ww / 2 - 1.5, wy, 3, wh);
        h.fillStyle = '#acacac';
        h.fillRect(wx - 3, wy + wh + 1, ww + 6, 3);
        r.strokeStyle = '#bebebe';
        r.lineWidth = 3;
        r.strokeRect(wx, wy, ww, wh);
        r.fillStyle = '#bebebe';
        r.fillRect(wx + ww / 2 - 1.5, wy, 3, wh);
      } else if (style === 'office') {
        m.fillStyle = 'rgba(30,40,50,0.6)';
        for (let k = 0; k < 4; k++) m.fillRect(x0 + (cell / 4) * k, wy, 2, wh);
        h.fillStyle = '#969696';
        r.fillStyle = '#999999';
        for (let k = 0; k < 4; k++) {
          h.fillRect(x0 + (cell / 4) * k, wy, 2, wh);
          r.fillRect(x0 + (cell / 4) * k, wy, 2, wh);
        }
      } else if (style === 'hotel') {
        // Balcony rail.
        m.fillStyle = '#d8d4cc';
        m.fillRect(x0, y0 + cell - 16, cell, 6);
        m.fillStyle = 'rgba(40,40,40,0.5)';
        for (let k = 0; k < cell; k += 6) m.fillRect(x0 + k, y0 + cell - 22, 1.5, 8);
        h.fillStyle = '#a0a0a0';
        h.fillRect(x0, y0 + cell - 16, cell, 6);
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
      glassMask(e, rng, style, wx, wy, ww, wh, x0, cell);
    }
  }
  return { map: toTexture(cm), emissive: toTexture(ce), rough: toTexture(cr, false), normal: normalFromHeight(ch, 2.4) };
}

/**
 * Night glass mask of one window: how much of it can glow (brighter under the ceiling, with
 * blinds, curtains and frames). Whether a window is lit, and in which colour, is decided per
 * window and per building by the facade shader in city/buildings.ts, so nothing here is lit or unlit.
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
