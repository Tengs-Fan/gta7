// The Moonbeam Drive-In (world/country/places.ts): the screen and what it shows (sim/driveIn.ts's reel, drawn into its
// own canvas only when the scene changes: title cards, silhouettes against a grey sky, the lines burned in under them,
// the dancing hot dog at the intermission), the screen's back with the drive-in's name to the city, the booth, the
// concession stand, the marquee by the gate and the speaker posts (props: speakerGeometry); a soft blue glow on the
// front rows while a reel runs after dark; and the parked cars' headlights flashing at a horn (driveInShush). The
// screen, the glow and the flashes are a draw each; the rest is the drive-in's piece of the atlas.

import * as THREE from 'three';
import { FILMS, reelAt, type Reel, type ReelId, type Scene } from '../../sim/driveIn';
import type { ViewState } from '../../sim/viewState';
import { rectContains } from '../../world/layout';
import { boxC } from '../city/attractions';
import { prism } from '../city/rooftops';
import { box, cyl, ModelBuilder } from '../furniture';
import type { RGB } from '../geo';
import { canvas, glowTexture, toTexture } from '../textures/misc';
import type { CountryView } from './index';
import { DIRT_Y, type PlacesKit } from './kit';
import { SIGN_GLOW } from './town';

/** The screen's canvas, its picture's aspect (30 x 14 m). */
const SW = 1024;
const SH = 478;
/** How long (s) the cars flash their lights at a horn, blinking FLASH_RATE times a second. */
const FLASH_TIME = 1.6;
const FLASH_RATE = 3;
/** Headlights the flashes have room for: two to a bay. */
const FLASHES = 96;

/** A speaker post: a pipe with the speaker box hung on its top, its grille to +z. */
export function speakerGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('post', cyl(0.05, 0.06, 1.25, 8), 0x6c6f73);
  b.add('base', cyl(0.14, 0.16, 0.06, 8), 0x55585c);
  b.add('box', box(0.32, 0.24, 0.14, 0, 1.2, 0.06), 0x9aa3a8);
  b.add('grille', box(0.24, 0.16, 0.01, 0, 1.24, 0.135), 0x2a2d30);
  return b.build('speaker');
}

/** Silhouettes in black on the canvas: a person `h` px tall standing at (x, y), a skirt or a coat. */
function figure(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, skirt: boolean): void {
  ctx.beginPath();
  ctx.arc(x, y - h * 0.9, h * 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - h * 0.12, y - h * 0.78);
  ctx.lineTo(x + h * 0.12, y - h * 0.78);
  ctx.lineTo(x + (skirt ? h * 0.2 : h * 0.13), y - h * (skirt ? 0.3 : 0.45));
  ctx.lineTo(x - (skirt ? h * 0.2 : h * 0.13), y - h * (skirt ? 0.3 : 0.45));
  ctx.fill();
  ctx.fillRect(x - h * 0.09, y - h * 0.45, h * 0.07, h * 0.45);
  ctx.fillRect(x + h * 0.02, y - h * 0.45, h * 0.07, h * 0.45);
}

/** The monster of the reel: a giant cob with angry eyes, or a scarecrow with its hat and its arms out. */
function monster(ctx: CanvasRenderingContext2D, reel: ReelId, x: number, y: number, h: number): void {
  ctx.fillStyle = '#0c0c0c';
  if (reel === 'corn') {
    ctx.beginPath();
    ctx.ellipse(x, y - h / 2, h * 0.17, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + s * h * 0.35, y - h * 0.3, x + s * h * 0.3, y - h * 0.7);
      ctx.lineTo(x + s * h * 0.1, y - h * 0.2);
      ctx.fill();
    }
    ctx.fillStyle = '#e8e8e8';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x + s * h * 0.03, y - h * 0.72);
      ctx.lineTo(x + s * h * 0.12, y - h * 0.76);
      ctx.lineTo(x + s * h * 0.1, y - h * 0.69);
      ctx.fill();
    }
    return;
  }
  ctx.fillRect(x - h * 0.03, y - h * 0.8, h * 0.06, h * 0.8);
  ctx.fillRect(x - h * 0.4, y - h * 0.66, h * 0.8, h * 0.05);
  ctx.beginPath();
  ctx.moveTo(x - h * 0.16, y - h * 0.68);
  ctx.lineTo(x + h * 0.16, y - h * 0.68);
  ctx.lineTo(x + h * 0.22, y - h * 0.3);
  ctx.lineTo(x - h * 0.22, y - h * 0.3);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y - h * 0.78, h * 0.09, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(x - h * 0.16, y - h * 0.9, h * 0.32, h * 0.03);
  ctx.fillRect(x - h * 0.08, y - h * 0.99, h * 0.16, h * 0.1);
  // Straw at its cuffs.
  for (const s of [-1, 1]) for (let k = 0; k < 4; k++) ctx.fillRect(x + s * (h * 0.4 + k * 4), y - h * 0.66 + k * 6, s * 10, 3);
}

/** The words of a title card, a line over two if it is long. */
function words(ctx: CanvasRenderingContext2D, text: string, y: number, size: number, color: string): void {
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${size}px Anton, Impact, "Arial Black", sans-serif`;
  ctx.fillText(text, SW / 2, y, SW - 60);
}

/** Draws a scene of reel `reel` onto the screen's canvas (`pose`: the hot dog's step). */
function drawScene(ctx: CanvasRenderingContext2D, reel: ReelId, s: Scene, pose: number): void {
  ctx.save();
  if (s.set === 'hotdog') {
    // The intermission, in colour: a hot dog dancing on a sunburst.
    ctx.fillStyle = '#f7c531';
    ctx.fillRect(0, 0, SW, SH);
    ctx.fillStyle = '#e8492f';
    for (let k = 0; k < 16; k++) {
      ctx.beginPath();
      ctx.moveTo(SW / 2, SH * 0.55);
      ctx.arc(SW / 2, SH * 0.55, SW, (k * Math.PI) / 8, ((k + 0.5) * Math.PI) / 8);
      ctx.fill();
    }
    // Standing on end, swaying from foot to foot, a cane in one hand and a straw hat on.
    ctx.translate(SW / 2, SH * 0.6);
    ctx.rotate(pose === 0 ? -0.14 : 0.14);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [x, k] of [[-28, pose], [28, 1 - pose]] as const) {
      ctx.moveTo(x, 95);
      ctx.lineTo(x + (k === 0 ? -30 : 10), 165);
      ctx.lineTo(x + (k === 0 ? -50 : 30), 165);
    }
    ctx.moveTo(-60, 0);
    ctx.lineTo(-120, pose === 0 ? -60 : 30);
    ctx.moveTo(60, 0);
    ctx.lineTo(118, pose === 0 ? 40 : -40);
    ctx.moveTo(118, pose === 0 ? 40 : -40);
    ctx.lineTo(118, pose === 0 ? 150 : 70);
    ctx.stroke();
    ctx.fillStyle = '#e3a453';
    ctx.beginPath();
    ctx.ellipse(0, 0, 70, 112, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b5402a';
    ctx.beginPath();
    ctx.ellipse(0, -6, 38, 128, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#f2d02a';
    ctx.lineWidth = 9;
    ctx.beginPath();
    for (let y = -100; y <= 90; y += 22) ctx.lineTo((y / 22) % 2 === 0 ? -16 : 16, y);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const x of [-14, 14]) {
      ctx.beginPath();
      ctx.arc(x, -70, 10, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#111';
    for (const x of [-14, 14]) {
      ctx.beginPath();
      ctx.arc(x + 3, -68, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(0, -46, 16, 0.2, Math.PI - 0.2);
    ctx.stroke();
    ctx.fillStyle = '#e8cf7a';
    ctx.fillRect(-48, -146, 96, 10);
    ctx.fillRect(-30, -170, 60, 26);
    ctx.restore();
    words(ctx, s.title![0], 56, 80, '#2a1206');
    words(ctx, s.title![1], 448, 38, '#2a1206');
    return;
  }
  if (s.set === 'marquee') {
    ctx.fillStyle = '#0d1430';
    ctx.fillRect(0, 0, SW, SH);
    ctx.fillStyle = '#f5f0c8';
    for (let k = 0; k < 60; k++) ctx.fillRect((k * 397) % SW, (k * 211) % SH, 3, 3);
    words(ctx, s.title![0], 170, 110, '#ffd84a');
    words(ctx, s.title![1], 320, 34, '#9fe8ff');
    ctx.restore();
    return;
  }
  // The films, in black and white.
  const sky = ctx.createLinearGradient(0, 0, 0, SH);
  sky.addColorStop(0, s.set === 'title' || s.set === 'end' ? '#0b0b0b' : '#8f8f8f');
  sky.addColorStop(1, s.set === 'title' || s.set === 'end' ? '#1a1a1a' : '#d2d2d2');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, SW, SH);
  ctx.fillStyle = '#0c0c0c';
  const g = SH * 0.8;
  switch (s.set) {
    case 'title':
    case 'end':
      words(ctx, s.title![0], s.set === 'end' ? 200 : 180, s.set === 'end' ? 120 : 84, '#f2f2f2');
      words(ctx, s.title![1], 330, 38, '#cfcfcf');
      break;
    case 'field':
      ctx.fillRect(0, g, SW, SH - g);
      for (let x = 0; x < SW; x += 22) {
        ctx.beginPath();
        ctx.moveTo(x, g);
        ctx.lineTo(x + 6, g - 70 - ((x * 7) % 30));
        ctx.lineTo(x + 12, g);
        ctx.fill();
      }
      ctx.fillStyle = '#f0f0f0';
      ctx.beginPath();
      ctx.arc(820, 90, 36, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0c0c0c';
      figure(ctx, 300, g + 30, 150, false);
      figure(ctx, 380, g + 30, 140, true);
      monster(ctx, reel, 760, g - 20, reel === 'corn' ? 200 : 260);
      break;
    case 'lab':
      ctx.fillRect(0, g, SW, SH - g);
      ctx.fillRect(120, g - 70, 380, 12);
      for (const x of [150, 220, 300, 420]) {
        ctx.beginPath();
        ctx.moveTo(x, g - 70);
        ctx.lineTo(x - 18, g - 70);
        ctx.lineTo(x - 8, g - 120);
        ctx.lineTo(x - 8, g - 150);
        ctx.lineTo(x + 8, g - 150);
        ctx.lineTo(x + 8, g - 120);
        ctx.lineTo(x + 18, g - 70);
        ctx.fill();
      }
      ctx.fillRect(640, 60, 260, 200);
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(656, 76, 228, 168);
      ctx.fillStyle = '#0c0c0c';
      monster(ctx, reel, 770, 244, 150);
      figure(ctx, 560, g + 20, 190, false);
      figure(ctx, 470, g + 20, 175, true);
      break;
    case 'city':
      for (let x = 0; x < SW; x += 60) ctx.fillRect(x, g - 80 - ((x * 13) % 120), 52, 200);
      ctx.fillRect(0, g, SW, SH - g);
      monster(ctx, reel, 600, g, 330);
      for (const x of [140, 200, 250, 900]) figure(ctx, x, SH - 20, 60, x % 100 === 0);
      break;
    case 'farmhouse':
      ctx.fillRect(0, g, SW, SH - g);
      ctx.fillRect(160, g - 140, 300, 140);
      ctx.beginPath();
      ctx.moveTo(140, g - 140);
      ctx.lineTo(310, g - 230);
      ctx.lineTo(480, g - 140);
      ctx.fill();
      ctx.fillStyle = '#cfcfcf';
      for (const x of [200, 380]) ctx.fillRect(x, g - 110, 40, 40);
      ctx.fillStyle = '#0c0c0c';
      figure(ctx, 620, g + 30, 170, false);
      figure(ctx, 700, g + 30, 155, true);
      break;
    case 'tower':
      ctx.fillRect(0, g, SW, SH - g);
      ctx.fillRect(380, 150, 12, g - 150);
      ctx.fillRect(560, 150, 12, g - 150);
      ctx.beginPath();
      ctx.ellipse(476, 120, 130, 60, 0, 0, Math.PI * 2);
      ctx.fill();
      figure(ctx, 760, g + 30, 160, false);
      figure(ctx, 820, g + 30, 150, true);
      monster(ctx, reel, 160, g, 260);
      break;
  }
  // The line burned in under the picture.
  if (s.line) {
    ctx.font = '600 34px Rajdhani, "Arial Narrow", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#000';
    ctx.strokeText(s.line, SW / 2, SH - 34, SW - 40);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(s.line, SW / 2, SH - 34, SW - 40);
  }
  // Scratches and a dark edge: an old print.
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  for (let k = 0; k < 6; k++) ctx.fillRect((k * 173 + s.minutes * 31) % SW, 0, 2, SH);
  const v = ctx.createRadialGradient(SW / 2, SH / 2, SH * 0.35, SW / 2, SH / 2, SW * 0.62);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, SW, SH);
  ctx.restore();
}

export function buildDriveIn(view: CountryView, kit: PlacesKit): { update: (night: number, time: number, sim: ViewState | null) => void; shush: (time: number) => void } {
  const d = view.world.layout.country.places.driveIn;
  const p = kit.place('moonbeam-drive-in');
  const sc = d.screen;
  const zc = (sc.z0 + sc.z1) / 2;

  // The lot and the drive in from Creek Road, packed dirt.
  const dirtUv = { kind: 'world', scale: view.city.ground.tile('plain') } as const;
  for (const r of [d.lot, d.drive]) kit.dirt.flat(r.minX, r.minZ, r.maxX, r.maxZ, DIRT_Y, dirtUv);

  // The screen's frame: a dark wall on its scaffold, a white border round the picture, and the name on its back to the
  // city across the sound.
  const f = d.frame;
  const frame: RGB = [0.22, 0.24, 0.23];
  boxC(p.plain, f.minX, 0, f.minZ, f.maxX, sc.y1 + 0.5, f.maxZ, frame);
  for (const [z0, z1] of [[sc.z0 - 0.5, sc.z0], [sc.z1, sc.z1 + 0.5]] as const) boxC(p.plain, f.minX - 0.03, sc.y0 - 0.5, z0, f.minX, sc.y1 + 0.5, z1, [0.92, 0.92, 0.9]);
  boxC(p.plain, f.minX - 0.03, sc.y0 - 0.5, sc.z0, f.minX, sc.y0, sc.z1, [0.92, 0.92, 0.9]);
  boxC(p.plain, f.minX - 0.03, sc.y1, sc.z0, f.minX, sc.y1 + 0.5, sc.z1, [0.92, 0.92, 0.9]);
  for (let z = f.minZ + 2; z < f.maxZ; z += 6) boxC(p.plain, f.maxX, 0, z - 0.2, f.maxX + 2.6, 0.6, z + 0.2, [0.3, 0.3, 0.3]);
  const back = kit.atlas.band(192, (ctx) => {
    const glow = ctx.canvas !== kit.atlas.canvas;
    ctx.fillStyle = glow ? '#000' : '#1b2238';
    ctx.fillRect(0, 0, 1024, 192);
    if (glow) ctx.globalAlpha = SIGN_GLOW;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f7e27a';
    ctx.font = '700 120px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText('MOONBEAM', 512, 84, 980);
    ctx.fillStyle = '#9fd8ff';
    ctx.font = '700 44px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText('DRIVE-IN · LAS LOMAS COUNTY', 512, 160, 980);
  }, true);
  kit.board(p, back, 24, 4.5, f.maxX + 0.03, sc.y1 - 3.5, zc, Math.PI / 2);

  // The booth: a white block with a flat roof, its projector's window to the screen.
  const b = d.booth;
  boxC(p.plain, b.minX, 0, b.minZ, b.maxX, 4.4, b.maxZ, [0.93, 0.92, 0.88]);
  boxC(p.plain, b.minX - 0.3, 4.4, b.minZ - 0.3, b.maxX + 0.3, 4.65, b.maxZ + 0.3, [0.2, 0.55, 0.6]);
  boxC(p.plain, b.maxX, 2.6, zc - 0.6, b.maxX + 0.04, 3.4, zc + 0.6, [0.05, 0.05, 0.06]);
  // The stand: cream with a teal roof, its counter to the lot and its sign over it.
  const st = d.stand;
  boxC(p.plain, st.minX, 0, st.minZ, st.maxX, 3.5, st.maxZ, [0.95, 0.9, 0.78]);
  boxC(p.plain, st.minX - 0.6, 3.5, st.minZ - 0.6, st.maxX + 0.6, 3.75, st.maxZ + 1.6, [0.2, 0.55, 0.6]);
  const counter = kit.atlas.band(96, (ctx) => {
    const glow = ctx.canvas !== kit.atlas.canvas;
    ctx.fillStyle = glow ? '#000' : '#7a2b20';
    ctx.fillRect(0, 0, 1024, 96);
    ctx.fillStyle = glow ? '#3a2c12' : '#f6d48a';
    ctx.fillRect(40, 10, 944, 60);
  }, true);
  kit.board(p, counter, st.maxX - st.minX - 1, 1.6, (st.minX + st.maxX) / 2, 1.6, st.maxZ + 0.03, 0);
  const menu = kit.atlas.band(128, (ctx) => {
    const glow = ctx.canvas !== kit.atlas.canvas;
    ctx.fillStyle = glow ? '#000' : '#c42a2a';
    ctx.fillRect(0, 0, 1024, 128);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = glow ? '#6e6a60' : '#fff8e6';
    ctx.font = '700 64px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText('HOT DOGS. COLD SODA. LUKEWARM ROMANCE.', 512, 66, 990);
  }, true);
  kit.board(p, menu, st.maxX - st.minX + 0.8, 1.1, (st.minX + st.maxX) / 2, 4.3, st.maxZ + 1.62, 0);

  // The marquee by the gate: two posts and the board, the bill on both faces.
  const m = d.marquee;
  for (const dz of m.posts) prism(p.plain, m.x, m.z + dz, 0.25, 0.25, 0, 7.5, 8, [0.85, 0.85, 0.82]);
  boxC(p.plain, m.x - 0.25, 4.2, m.z - 5, m.x + 0.25, 7.8, m.z + 5, [0.1, 0.12, 0.2]);
  const bill = kit.atlas.band(320, (ctx) => {
    const glow = ctx.canvas !== kit.atlas.canvas;
    ctx.fillStyle = glow ? '#000' : '#f6f2e2';
    ctx.fillRect(0, 0, 1024, 320);
    ctx.fillStyle = glow ? '#000' : '#1b2238';
    ctx.fillRect(0, 0, 1024, 120);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (glow) ctx.globalAlpha = SIGN_GLOW;
    ctx.fillStyle = '#f7e27a';
    ctx.font = '700 96px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText('MOONBEAM DRIVE-IN', 512, 62, 990);
    // The bill's letters are black on the lit board: in the glow, the board round them.
    if (glow) {
      ctx.fillStyle = '#f6f2e2';
      ctx.fillRect(0, 120, 1024, 200);
    }
    ctx.fillStyle = '#1b1b1b';
    ctx.font = '700 46px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText('TONIGHT: THE CORN THAT ATE SAN AZURA', 512, 176, 990);
    ctx.fillText('· ATTACK OF THE 50-FOOT SCARECROW ·', 512, 252, 990);
  }, true);
  kit.board(p, bill, 9.6, 3.2, m.x - 0.27, 6, m.z, -Math.PI / 2);
  kit.board(p, bill, 9.6, 3.2, m.x + 0.27, 6, m.z, Math.PI / 2);

  // The screen itself: the reel's canvas, bright after dark while it runs.
  const [c, ctx] = canvas(SW, SH);
  const tex = toTexture(c, true, false);
  const screenMat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(0.85, 0.85, 0.85) });
  const screen = new THREE.PlaneGeometry(sc.z1 - sc.z0, sc.y1 - sc.y0);
  screen.rotateY(-Math.PI / 2);
  screen.translate(sc.x, (sc.y0 + sc.y1) / 2, zc);
  view.add(screen, screenMat, { split: false, receive: false, name: 'drive-in-screen' });

  // A pool of the screen's blue light on the front rows: additive, its strength the screen's.
  const [gc, gx] = canvas(64, 64);
  const pool = gx.createRadialGradient(32, 32, 0, 32, 32, 32);
  pool.addColorStop(0, 'rgba(120,170,255,1)');
  pool.addColorStop(1, 'rgba(120,170,255,0)');
  gx.fillStyle = pool;
  gx.fillRect(0, 0, 64, 64);
  // On the ground before the screen, a little over the dirt.
  const light = new THREE.PlaneGeometry(40, sc.z1 - sc.z0 + 8);
  light.rotateX(-Math.PI / 2);
  light.translate(sc.x - 20, 0.08, zc);
  // Light adds to what is behind it, so no fog: fogged, it would add the fog's colour too.
  const lightMat = new THREE.MeshBasicMaterial({ map: toTexture(gc, true, false), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  view.add(light, lightMat, { split: false, receive: false, name: 'drive-in-light' });

  // The flashes: a glow at each headlight of the cars parked in the lot while they flash at a horn.
  const flashGeo = new THREE.BufferGeometry();
  const flashPos = new Float32Array(FLASHES * 3);
  flashGeo.setAttribute('position', new THREE.BufferAttribute(flashPos, 3));
  const flashes = new THREE.Points(flashGeo, new THREE.PointsMaterial({ map: glowTexture(), color: 0xfff4d8, size: 1.7, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  flashes.frustumCulled = false;
  flashes.visible = false;
  flashes.name = 'drive-in-flashes';
  view.group.add(flashes);

  let drawn = '';
  let shushAt = -Infinity;
  const show = (r: Reel) => {
    const s = FILMS[r.reel][r.scene]!;
    const pose = s.set === 'hotdog' ? Math.floor(r.t * 2) % 2 : 0;
    const key = `${r.reel}:${r.scene}:${pose}`;
    if (key === drawn) return;
    drawn = key;
    drawScene(ctx, r.reel, s, pose);
    tex.needsUpdate = true;
  };
  return {
    shush: (time) => {
      shushAt = time;
    },
    update: (night, time, sim) => {
      const r = sim ? reelAt(sim.clock.hours) : null;
      if (r) show(r);
      else if (drawn !== 'dark') {
        drawn = 'dark';
        ctx.fillStyle = '#d8d8d4';
        ctx.fillRect(0, 0, SW, SH);
        tex.needsUpdate = true;
      }
      // A white panel by day; while a reel runs, a picture that outshines the dusk.
      screenMat.color.setScalar(r ? 0.45 + night * 0.8 : 0.85 * (1 - night) + 0.08);
      lightMat.opacity = r ? night * 0.35 : 0;
      const on = sim !== null && time - shushAt < FLASH_TIME && Math.floor((time - shushAt) * FLASH_RATE * 2) % 2 === 0;
      flashes.visible = on;
      if (!on) return;
      let n = 0;
      for (const v of sim.vehicles) {
        if (v.removed || v.owner !== 'parked' || !rectContains(d.lot, v.pos.x, v.pos.z) || n >= FLASHES) continue;
        const fx = Math.sin(v.heading);
        const fz = Math.cos(v.heading);
        for (const side of [-0.65, 0.65]) {
          flashPos.set([v.pos.x + fx * v.halfL + fz * side, v.pos.y + 0.75, v.pos.z + fz * v.halfL - fx * side], n * 3);
          n++;
        }
      }
      flashGeo.setDrawRange(0, n);
      flashGeo.getAttribute('position').needsUpdate = true;
    },
  };
}
