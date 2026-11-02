// Pinewood and the valley's north (world/country/woods.ts): the dirt lanes and the gravel pads of the lake and the wood (draped
// on the ground, one draw with the places' dirt), the fire lookout tower on Pine Rise with its cab's windows lit at night, the
// boulders (the pass's own shapes and rock) and the wildflowers: tufts on crossed cards, swaying on the props' wind.
// The pines are PropsView's (render/country/pineModels.ts).

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { PINE_TOWER } from '../../world/country/woods';
import type { CountyLakeland, FlowerHue, FlowerPatch } from '../../world/country/lakeland';
import type { WindUniforms } from '../props';
import { canvas, toTexture } from '../textures/misc';
import { boulders, lookoutTower, rockMaterial } from './hills';
import { swayOnWind } from './lake';
import { DIRT_Y, type PlacesKit } from './kit';
import type { CountryView } from './index';

/** The flower hues: where each one's tuft sits in the atlas (a column), and its blooms' colours. */
const HUES: Readonly<Record<FlowerHue, { column: number; bloom: readonly string[]; spike: boolean }>> = {
  buttercup: { column: 0, bloom: ['#ffd21f', '#ffe35a', '#f5b800'], spike: false },
  lupine: { column: 1, bloom: ['#7b52c9', '#9a74e0', '#5b3aa8'], spike: true },
  daisy: { column: 2, bloom: ['#ffffff', '#f4f1e8', '#ffffff'], spike: false },
  poppy: { column: 3, bloom: ['#e8431f', '#f26b3a', '#cf2c14'], spike: false },
  clover: { column: 4, bloom: ['#e88ac0', '#f4a9d2', '#d96aa8'], spike: false },
  grass: { column: 5, bloom: ['#c9b458', '#d8c66a', '#b0a04a'], spike: false },
};
const COLUMNS = 6;
const TUFT = 128;

/** The wildflower atlas: a tuft of each hue, grass blades and stems with blooms, on a transparent ground (alpha-tested). */
function flowerAtlas(): THREE.Texture {
  const [c, ctx] = canvas(TUFT * COLUMNS, TUFT);
  ctx.clearRect(0, 0, TUFT * COLUMNS, TUFT);
  const rng = new Rng(5521);
  for (const hue of Object.values(HUES)) {
    const x0 = hue.column * TUFT;
    if (hue === HUES.grass) {
      // Tall grass: fans of thin blades from the foot, golden and green, with a few seed heads.
      for (let k = 0; k < 34; k++) {
        const x = x0 + rng.range(10, TUFT - 10);
        const top = TUFT * rng.range(0.08, 0.6);
        const g = rng.int(0, 2);
        ctx.strokeStyle = ['#8c9a3c', '#a89c4a', '#6d8838'][g]!;
        ctx.lineWidth = rng.range(1.6, 2.8);
        ctx.beginPath();
        ctx.moveTo(x + rng.range(-8, 8), TUFT);
        ctx.quadraticCurveTo(x + rng.range(-5, 5), TUFT * 0.6, x + rng.range(-16, 16), top);
        ctx.stroke();
        if (k % 5 === 0) {
          ctx.fillStyle = hue.bloom[k % 3]!;
          ctx.beginPath();
          ctx.ellipse(x + rng.range(-10, 10), top + 6, 2.6, 8, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      continue;
    }
    for (let k = 0; k < 9; k++) {
      const x = x0 + rng.range(26, TUFT - 26);
      ctx.strokeStyle = `rgb(${rng.int(56, 86)},${rng.int(110, 150)},${rng.int(40, 60)})`;
      ctx.lineWidth = rng.range(2.5, 4);
      ctx.beginPath();
      ctx.moveTo(x, TUFT);
      ctx.quadraticCurveTo(x + rng.range(-8, 8), TUFT * 0.65, x + rng.range(-14, 14), TUFT * rng.range(0.34, 0.6));
      ctx.stroke();
    }
    for (let k = 0; k < 7; k++) {
      const x = x0 + 18 + (k / 6) * (TUFT - 36) + rng.range(-5, 5);
      const top = TUFT * rng.range(0.1, 0.45);
      ctx.strokeStyle = '#4c7a2c';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(x + rng.range(-6, 6), TUFT);
      ctx.lineTo(x, top);
      ctx.stroke();
      ctx.fillStyle = hue.bloom[k % hue.bloom.length]!;
      if (hue.spike) {
        for (let j = 0; j < 6; j++) {
          ctx.beginPath();
          ctx.ellipse(x + (j % 2 ? 3 : -3), top + j * 7, 5, 4, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        const r = rng.range(8, 12);
        ctx.beginPath();
        ctx.arc(x, top, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = hue.bloom[0] === '#ffffff' ? '#f2b400' : 'rgba(60,40,0,0.55)';
        ctx.beginPath();
        ctx.arc(x, top, r * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return toTexture(c, true, false);
}

/** A patch's tufts: two crossed cards each, in a disc, their sizes and turns from the patch's own seed. */
function flowerGeometry(view: CountryView, patches: readonly FlowerPatch[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const sway: number[] = [];
  const idx: number[] = [];
  for (const patch of patches) {
    const rng = new Rng(patch.seed * 7919);
    const { column } = HUES[patch.hue];
    for (let k = 0; k < patch.count; k++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * patch.r;
      const x = patch.x + Math.cos(a) * d;
      const z = patch.z + Math.sin(a) * d;
      const y = view.world.groundHeight(x, z) - 0.03;
      const w = patch.hue === 'grass' ? rng.range(1.0, 1.6) : rng.range(0.55, 0.95);
      const h = w * (patch.hue === 'grass' ? rng.range(0.8, 1.05) : rng.range(0.7, 0.95));
      const turn = rng.range(0, Math.PI);
      const shade = rng.range(0.82, 1.1);
      // The edge of the patch is thin: a card near it is smaller.
      const edge = 1 - 0.45 * Math.max(0, (d / patch.r - 0.7) / 0.3);
      for (const t of [turn, turn + Math.PI / 2]) {
        const dx = Math.cos(t) * (w / 2) * edge;
        const dz = Math.sin(t) * (w / 2) * edge;
        const base = pos.length / 3;
        pos.push(x - dx, y, z - dz, x + dx, y, z + dz, x + dx, y + h * edge, z + dz, x - dx, y + h * edge, z - dz);
        for (let i = 0; i < 4; i++) {
          nrm.push(0, 1, 0);
          col.push(shade, shade, shade);
        }
        const u0 = column / COLUMNS;
        const u1 = (column + 1) / COLUMNS;
        uv.push(u0, 0, u1, 0, u1, 1, u0, 1);
        sway.push(0, 0, 1, 1);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx.length > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  return g;
}

export function buildWoods(view: CountryView, kit: PlacesKit, wind: WindUniforms): void {
  const world = view.world;
  const land: CountyLakeland = world.layout.country.lakeland;
  const ground = (x: number, z: number) => world.groundHeight(x, z);

  // The dirt: every pad on its ground, and every lane as a strip along its centre line, each edge on the ground under it.
  const uv = { kind: 'world', scale: view.city.ground.tile('plain') } as const;
  for (const r of land.pads) kit.dirt.heightGrid(r.minX, r.minZ, r.maxX, r.maxZ, 4, (x, z) => ground(x, z) + DIRT_Y + 0.01, uv);
  for (const lane of land.lanes) {
    const half = lane.width / 2;
    const n = lane.pts.length / 2;
    const edge = (i: number, side: number): [number, number, number] => {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const tx = lane.pts[2 * b]! - lane.pts[2 * a]!;
      const tz = lane.pts[2 * b + 1]! - lane.pts[2 * a + 1]!;
      const l = Math.hypot(tx, tz) || 1;
      const x = lane.pts[2 * i]! - (tz / l) * half * side;
      const z = lane.pts[2 * i + 1]! + (tx / l) * half * side;
      return [x, ground(x, z) + DIRT_Y + 0.01, z];
    };
    for (let i = 1; i < n; i++) {
      const [ax, ay, az] = edge(i - 1, 1);
      const [bx, by, bz] = edge(i, 1);
      const [cx, cy, cz] = edge(i, -1);
      const [dx, dy, dz] = edge(i - 1, -1);
      const s = 1 / uv.scale;
      kit.dirt.quad(dx, dy, dz, cx, cy, cz, bx, by, bz, ax, ay, az, [dx * s, -dz * s, cx * s, -cz * s, bx * s, -bz * s, ax * s, -az * s]);
    }
  }

  // The fire lookout: the tower's timber frame (the ridge's, taller) with its cab's windows lit after dark: a board on each
  // side, the glass's colour by day and a warm amber in the glow.
  const t = PINE_TOWER;
  const top = ground(t.x, t.z);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  mat.name = 'pine-lookout';
  view.add(lookoutTower(top, t), mat, { shadow: true, name: 'pine-lookout', split: false });
  const p = kit.place('pine-lookout-windows');
  const glass = kit.atlas.band(96, (ctx) => {
    const glow = ctx.canvas !== kit.atlas.canvas;
    ctx.fillStyle = glow ? '#6e5026' : '#26323c';
    ctx.fillRect(0, 0, 1024, 96);
    ctx.fillStyle = glow ? '#000' : '#3d3a30';
    for (let k = 0; k <= 4; k++) ctx.fillRect(k * 255, 0, 8, 96);
    if (!glow) {
      ctx.fillStyle = 'rgba(170,200,220,0.25)';
      ctx.fillRect(0, 0, 1024, 30);
    }
  }, true);
  const cab = t.half + 0.3;
  const sill = t.cab + 1.1;
  const head = t.top - 1.2;
  for (const rot of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    kit.board(p, glass, cab * 2 - 0.4, head - sill - 0.1, t.x + Math.sin(rot) * (cab + 0.01), top + (sill + head) / 2, t.z + Math.cos(rot) * (cab + 0.01), rot);
  }

  // The boulders, in the pass's rock.
  if (land.boulders.length > 0) view.add(boulders(land.boulders), rockMaterial(view), { shadow: true, name: 'valley-rocks' });

  // The wildflowers: tufts of two crossed cards, alpha-tested, swaying on the wind.
  if (land.flowers.length + land.tussocks.length > 0) {
    const flowerMat = new THREE.MeshStandardMaterial({ map: flowerAtlas(), vertexColors: true, alphaTest: 0.5, roughness: 0.9, side: THREE.DoubleSide });
    swayOnWind(flowerMat, wind, 1.4);
    view.add(flowerGeometry(view, [...land.flowers, ...land.tussocks]), flowerMat, { name: 'wildflowers', receive: false });
  }
}
