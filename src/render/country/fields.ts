// Las Lomas County's fields (world/country/farms.ts) at field scale, priced by what the camera sees:
// - every field's ground is a slab just over the grass with its crop's row texture (render/textures/ground.ts), turned
//   along its rows; wheat's ripples in the wind;
// - corn and sunflowers are one block each beyond the ring round the camera: an opaque top textured as the crop seen
//   from above and sides of stalks with a ragged top, front faces only, so from inside a field only the plants show
//   (on the software tier, which has no plants, both faces: from inside a field the corn stands round you);
// - within the ring (quality.ts CROP_RING: smaller on Medium and Low, none in software or from RING_TOP up), the plants, from
//   fixed pools: Hollister Farm's corn (its ten-stalk cards, swaying on the props' wind), wheat tufts and sunflowers,
//   whose heads turn with the sun. The pools are refilled when the camera crosses into another FIELD_CELL cell, each
//   plant at its own spot of its field's lattice (hashed, so nothing swims between refills), the ring centred on the
//   cell; across the ring's edge the plants and the blocks dither into each other;
// - the crop circle (world/country/oddities.ts) is mown into one wheat field: its tufts are left out where it is flat, and
//   a decal of flattened straw, swirled, lies over the field's slab there.

import * as THREE from 'three';
import { hashInts } from '../../world/layout';
import type { Crop, Field } from '../../world/country/farms';
import { isMown, type CropCircle } from '../../world/country/oddities';
import { CORN_H, CORN_LEN, cornGeometry, cornTexture } from '../attractionModels';
import { GeoBuilder } from '../geo';
import { fadeNearCamera, type WindUniforms } from '../props';
import { CROP_RING, type CropRing } from '../quality';
import { canvas, toTexture } from '../textures/misc';
import { CROP_TILE, cropTexture, type CropTex } from '../textures/ground';
import type { CountryView } from './index';

/** The pools are refilled when the camera crosses into another cell of this side (m). */
export const FIELD_CELL = 16;
/** Width (m) of the band at the ring's edge where plants and blocks dither into each other. */
const RING_FADE = 6;
/** Above this height (m) the camera looks down on the fields from too high for plants seen side on: blocks alone. */
const RING_TOP = 30;
/** The blocks' tops (m): a little under the plants' own, which reach past it. */
const BLOCK_H: Partial<Record<Crop, number>> = { corn: 2.45, sunflower: 1.9 };
/** Each crop's lattice: metres between plants along a row and between rows. */
const LATTICE: Partial<Record<Crop, { along: number; across: number }>> = {
  corn: { along: CORN_LEN, across: 1 },
  wheat: { along: 0.8, across: 0.8 },
  sunflower: { along: 0.9, across: 1 },
};
/** Wheat's height (m). */
const WHEAT_H = 0.95;
/** A sunflower's head: its height, and the head's radius. */
const SUN_HEAD_Y = 1.75;
const SUN_HEAD_R = 0.3;
const SLAB_Y = 0.02;
const SLAB_TEX: Readonly<Record<Crop, CropTex>> = { corn: 'soil', sunflower: 'soil', wheat: 'wheat', furrow: 'furrow', lettuce: 'lettuce' };

/** The row frame of a field: u along its rows, v across them. */
function frame(f: Field): { ux: number; uz: number; vx: number; vz: number } {
  return { ux: Math.sin(f.rowAngle), uz: Math.cos(f.rowAngle), vx: Math.cos(f.rowAngle), vz: -Math.sin(f.rowAngle) };
}

/** A 4x4 ordered dither, the foliage's (props.ts fadeBayer4). */
const BAYER_GLSL = /* glsl */ `
float cropBayer4( vec2 frag ) {
  const float m[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
  ivec2 p = ivec2( mod( floor( frag ), 4.0 ) );
  return ( m[ p.x + p.y * 4 ] + 0.5 ) / 16.0;
}`;

/** The share (0 inside, 1 outside) of the ring (x, z centre, radius, fade) at a world point, smoothed over its edge. */
const RING_GLSL = /* glsl */ `
float cropRing( vec2 p, vec4 ring ) {
  return clamp( ( distance( p, ring.xy ) - ( ring.z - ring.w ) ) / ring.w, 0.0, 1.0 );
}`;

/** A block's material: drawn only outside the ring (the plants are inside it), dithered over the ring's edge. */
function outsideRing(mat: THREE.Material, ring: { value: THREE.Vector4 }, key: string): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCropRing = ring;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCropXZ;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCropXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vCropXZ;\nuniform vec4 uCropRing;\n${BAYER_GLSL}\n${RING_GLSL}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif ( cropRing( vCropXZ, uCropRing ) < cropBayer4( gl_FragCoord.xy ) ) discard;');
  };
  mat.customProgramCacheKey = () => key;
}

/**
 * A plant pool's material on top of the foliage's near-camera dissolve (props.ts fadeNearCamera, which gives the world
 * position vFadeWorld): drawn only inside its ring, the blocks' dither turned round. `vertex` patches the vertex shader
 * further (wheat's ripple, a sunflower's turn to the sun).
 */
function insideRing(mat: THREE.Material, ring: { value: THREE.Vector4 }, key: string, wind?: WindUniforms, vertex?: (s: THREE.WebGLProgramParametersWithUniforms) => void): void {
  fadeNearCamera(mat, wind && !vertex ? { shared: wind, pivot: new THREE.Vector4(0, 0, 0, CORN_H) } : undefined);
  const fade = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    fade.call(mat, shader, renderer);
    vertex?.(shader);
    shader.uniforms.uCropRing = ring;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec4 uCropRing;\n${BAYER_GLSL}\n${RING_GLSL}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif ( cropRing( vFadeWorld.xz, uCropRing ) >= cropBayer4( gl_FragCoord.xy ) ) discard;');
  };
  mat.customProgramCacheKey = () => key;
}

/** A row of plants seen side on: the corn's card drawn over and over, or sunflowers' stalks and heads, ragged at the top. */
function wallTexture(crop: Crop): THREE.Texture {
  const W = 512;
  const H = 256;
  const [c, ctx] = canvas(W, H);
  ctx.clearRect(0, 0, W, H);
  if (crop === 'corn') {
    const card = cornTexture().image as HTMLCanvasElement;
    for (let k = 0; k < 26; k++) {
      const x = (k / 26) * W + ((k * 37) % 11) - 30;
      const h = H * (0.9 + ((k * 53) % 9) * 0.012);
      // The card's plant fills its height; drawn twice side by side so the wall wraps (it repeats along u).
      for (const dx of [0, -W, W]) ctx.drawImage(card, x + dx, H - h, 60, h);
    }
  } else {
    for (let k = 0; k < 18; k++) {
      const x = (k + 0.5) * (W / 18);
      const top = H * (0.08 + ((k * 29) % 7) * 0.01);
      ctx.fillStyle = '#4f7a2c';
      ctx.fillRect(x - 3, top, 6, H - top);
      for (let l = 0; l < 4; l++) {
        ctx.fillStyle = l % 2 ? '#5d8c34' : '#47722a';
        ctx.beginPath();
        ctx.ellipse(x + (l % 2 ? 12 : -12), top + 60 + l * 40, 16, 8, l % 2 ? 0.5 : -0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#f2c230';
      ctx.beginPath();
      ctx.arc(x, top + 12, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#5a3a1a';
      ctx.beginPath();
      ctx.arc(x, top + 12, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    // The field's depth behind the first row: leaves down to the ground.
    ctx.fillStyle = 'rgba(52,84,30,0.95)';
    ctx.fillRect(0, H * 0.45, W, H * 0.55);
  }
  const t = toTexture(c);
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** A field of tall crops seen from above: corn's leaves and tassels, or sunflowers' heads among their leaves. */
function topTexture(crop: Crop): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = crop === 'corn' ? '#4b6b2a' : '#3f6626';
  ctx.fillRect(0, 0, S, S);
  // The rows, a metre apart across the tile (as the soil's, ground.ts CROP_TILE), darker between the plants.
  for (let k = 0; k < CROP_TILE; k++) {
    ctx.fillStyle = 'rgba(28,40,14,0.55)';
    ctx.fillRect(0, k * (S / CROP_TILE) + 2, S, 10);
  }
  for (let k = 0; k < 900; k++) {
    const x = (hashInts(k, 1) % 1024) / 4;
    const y = (hashInts(k, 2) % 1024) / 4;
    const a = ((hashInts(k, 3) % 628) / 100);
    const g = 90 + (hashInts(k, 4) % 70);
    ctx.strokeStyle = `rgb(${Math.round(g * 0.6)},${g},${Math.round(g * 0.32)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9);
    ctx.stroke();
  }
  for (let k = 0; k < (crop === 'corn' ? 160 : 70); k++) {
    const x = (hashInts(k, 5) % 1024) / 4;
    const y = (hashInts(k, 6) % 1024) / 4;
    if (crop === 'corn') {
      ctx.fillStyle = 'rgba(216,183,90,0.85)';
      ctx.fillRect(x, y, 3, 3);
    } else {
      ctx.fillStyle = '#efbf2c';
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#5a3a1a';
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return toTexture(c);
}

/** A wheat tuft's card: a dozen stems with their heads and awns, on a transparent ground. */
function wheatTexture(): THREE.Texture {
  const [c, ctx] = canvas(128, 128);
  ctx.clearRect(0, 0, 128, 128);
  for (let k = 0; k < 14; k++) {
    const x = 8 + ((k * 61) % 112);
    const lean = ((k * 17) % 9) - 4;
    const top = 6 + ((k * 23) % 18);
    ctx.strokeStyle = '#b8954a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 128);
    ctx.quadraticCurveTo(x + lean, 70, x + lean * 2, top + 18);
    ctx.stroke();
    ctx.fillStyle = '#d9b860';
    ctx.beginPath();
    ctx.ellipse(x + lean * 2, top + 10, 3.5, 11, lean * 0.03, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(230,205,130,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + lean * 2, top + 2);
    ctx.lineTo(x + lean * 2 - 2, top - 6);
    ctx.stroke();
  }
  const t = toTexture(c, true, false);
  return t;
}

/** A wheat tuft: three cards crossed, WHEAT_H tall, drawn from both sides. */
function wheatGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) parts.push(new THREE.PlaneGeometry(0.75, WHEAT_H).translate(0, WHEAT_H / 2, 0).rotateY((k * Math.PI) / 3));
  return mergeAll(parts, 'wheat');
}

/** A sunflower facing +z: its stem, two leaves, the head's brown disc and its ring of petals. */
function sunflowerGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder(true);
  const stem: [number, number, number] = [0.2, 0.36, 0.1];
  const leaf: [number, number, number] = [0.07, 0.17, 0.03];
  const s = 0.025;
  for (const [ax, az, bx, bz] of [[-s, s, s, s], [s, s, s, -s], [s, -s, -s, -s], [-s, -s, -s, s]] as const) b.quad(ax, 0, az, bx, 0, bz, bx, SUN_HEAD_Y, bz, ax, SUN_HEAD_Y, az, [0, 0, 1, 0, 1, 1, 0, 1], stem);
  // The leaves droop from the stem.
  for (const [y, side] of [[0.7, 1], [1.15, -1]] as const) b.quad(0, y, 0, side * 0.2, y + 0.06, -0.13, side * 0.46, y - 0.14, 0, side * 0.2, y + 0.06, 0.13, [0, 0, 1, 0, 1, 1, 0, 1], leaf);
  // The head, its face to +z, tipped back a little from upright towards the sky.
  const n = 12;
  const cy = SUN_HEAD_Y + SUN_HEAD_R;
  const tilt = -0.35;
  const at = (r: number, a: number): [number, number, number] => [Math.cos(a) * r, cy + Math.sin(a) * r * Math.cos(tilt), 0.08 + Math.sin(a) * r * Math.sin(tilt)];
  const disc = SUN_HEAD_R * 0.42;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    const p0 = at(disc, a0);
    const p1 = at(disc, a1);
    const c0: [number, number, number] = [0, cy, 0.1];
    b.tri(...c0, ...p1, ...p0, [0, 0, 1, 0, 0, 1], [0.2, 0.11, 0.04]);
    // Two rings of petals, the second between the first's.
    b.tri(...p0, ...p1, ...at(SUN_HEAD_R, (a0 + a1) / 2), [0, 0, 1, 0, 0, 1], [1, 0.62, 0.03]);
    b.tri(...at(disc, a0 - Math.PI / n), ...at(disc, a0 + Math.PI / n), ...at(SUN_HEAD_R * 0.92, a0), [0, 0, 1, 0, 0, 1], [0.95, 0.52, 0.02]);
  }
  return b.build();
}

function mergeAll(parts: THREE.BufferGeometry[], name: string): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  for (const p of parts) {
    const g = p.index ? p.toNonIndexed() : p;
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nrm.push(...(g.getAttribute('normal').array as Float32Array));
    uv.push(...(g.getAttribute('uv').array as Float32Array));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.name = name;
  return g;
}

/** A plant of a pool: where it stands, how far from the ring's centre, its turn, height and size, and its tint. */
export interface Plant {
  x: number;
  z: number;
  d: number;
  yaw: number;
  h: number;
  s: number;
  tint: number;
}

/**
 * Every plant of `crop` within `radius` of (ox, oz), each at its own spot of its field's lattice (the field's index in
 * `fields` seeds the hash), however many: FieldsView.fill keeps the nearest its pool holds. None stands where `mown` is flat.
 */
export function cropPlants(fields: readonly Field[], crop: Crop, radius: number, ox: number, oz: number, mown?: CropCircle): Plant[] {
  const out: Plant[] = [];
  const lat = LATTICE[crop]!;
  fields.forEach((f, k) => {
    const r = f.rect;
    if (f.crop !== crop || radius <= 0 || ox + radius < r.minX || ox - radius > r.maxX || oz + radius < r.minZ || oz - radius > r.maxZ) return;
    const { ux, uz, vx, vz } = frame(f);
    const uc = ox * ux + oz * uz;
    const vc = ox * vx + oz * vz;
    for (let j = Math.floor((vc - radius) / lat.across); j <= Math.ceil((vc + radius) / lat.across); j++) {
      const v = (j + 0.5) * lat.across;
      const half = Math.sqrt(Math.max(0, radius * radius - (v - vc) ** 2));
      // Each row's plants shifted along it by a hash of the row, so the rows do not line up across.
      const shift = (hashInts(k, j, 7) % 1000) / 1000;
      for (let i = Math.floor((uc - half) / lat.along - shift); i <= Math.ceil((uc + half) / lat.along - shift); i++) {
        const h = hashInts(k, i, j);
        const ju = ((h & 0xff) / 255 - 0.5) * lat.along * 0.3;
        const jv = (((h >>> 8) & 0xff) / 255 - 0.5) * lat.across * (crop === 'corn' ? 0.3 : 0.5);
        const u = (i + shift + 0.5) * lat.along + ju;
        const vv = v + jv;
        const x = u * ux + vv * vx;
        const z = u * uz + vv * vz;
        if (x < r.minX + 0.4 || x > r.maxX - 0.4 || z < r.minZ + 0.4 || z > r.maxZ - 0.4) continue;
        if (mown?.field === k && isMown(mown, x, z)) continue;
        const d = Math.hypot(x - ox, z - oz);
        if (d > radius) continue;
        const yaw = crop === 'corn' ? f.rowAngle - Math.PI / 2 + (((h >>> 16) & 0xff) / 255 - 0.5) * 0.12 : (((h >>> 16) & 0xff) / 255) * Math.PI * 2;
        out.push({ x, z, d, yaw, h: 0.92 + (((h >>> 24) & 0xff) / 255) * 0.14, s: 0.9 + ((h % 97) / 97) * 0.2, tint: (h >>> 4) & 0xff });
      }
    }
  });
  return out;
}

/** One pool of plants: an instanced mesh of `capacity`, refilled from the fields of its crop within its ring. */
interface Pool {
  crop: Crop;
  mesh: THREE.InstancedMesh;
  ring: { value: THREE.Vector4 };
}

export class FieldsView {
  /** The slabs' materials: the ground the headlights light (the renderer's lightGround), as they are neither wet nor detailed. */
  readonly ground: THREE.MeshStandardMaterial[] = [];
  /** The plants' materials, which the headlights light as they do the slabs, in the same shading (the renderer's lightGround). */
  readonly crops: THREE.MeshStandardMaterial[] = [];
  private readonly fields: readonly Field[];
  private readonly circle: CropCircle;
  private readonly pools: Pool[] = [];
  /** The box round every field, grown by the largest ring: no refill when the camera is far outside it. */
  private readonly near: { minX: number; minZ: number; maxX: number; maxZ: number };
  private ring: CropRing = CROP_RING.high;
  private cellX = NaN;
  private cellZ = NaN;
  private high = false;
  /** The ring the blocks keep out of (x, z, radius, fade), shared by every block and the corn and sunflower pools. */
  private readonly tallRing = { value: new THREE.Vector4(0, 0, 0, RING_FADE) };
  private readonly wheatRing = { value: new THREE.Vector4(0, 0, 0, RING_FADE) };
  /** The sun's bearing (rad, as a heading: 0 towards +z) the sunflowers face. */
  private readonly sunYaw = { value: 0 };
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(view: CountryView, wind: WindUniforms) {
    this.fields = view.world.layout.country.farms.fields;
    this.circle = view.world.layout.country.oddities.cropCircle;
    const pad = Math.max(...Object.values(CROP_RING).map((r) => r.ring)) + FIELD_CELL;
    this.near = {
      minX: Math.min(...this.fields.map((f) => f.rect.minX)) - pad,
      minZ: Math.min(...this.fields.map((f) => f.rect.minZ)) - pad,
      maxX: Math.max(...this.fields.map((f) => f.rect.maxX)) + pad,
      maxZ: Math.max(...this.fields.map((f) => f.rect.maxZ)) + pad,
    };
    this.buildSlabs(view, wind);
    this.buildCircle(view);
    this.buildBlocks(view);
    this.buildPools(view, wind);
  }

  /** Every field's ground, one mesh per texture, the rows turned along the field's. */
  private buildSlabs(view: CountryView, wind: WindUniforms): void {
    const by = new Map<CropTex, GeoBuilder>();
    for (const f of this.fields) {
      const kind = SLAB_TEX[f.crop];
      let g = by.get(kind);
      if (!g) by.set(kind, (g = new GeoBuilder(false)));
      const { ux, uz, vx, vz } = frame(f);
      const r = f.rect;
      const uv = (x: number, z: number) => [(x * ux + z * uz) / CROP_TILE, (x * vx + z * vz) / CROP_TILE];
      g.quad(r.minX, SLAB_Y, r.maxZ, r.maxX, SLAB_Y, r.maxZ, r.maxX, SLAB_Y, r.minZ, r.minX, SLAB_Y, r.minZ, [...uv(r.minX, r.maxZ), ...uv(r.maxX, r.maxZ), ...uv(r.maxX, r.minZ), ...uv(r.minX, r.minZ)]);
    }
    for (const [kind, g] of by) {
      const mat = new THREE.MeshStandardMaterial({ map: cropTexture(kind), roughness: kind === 'lettuce' ? 0.8 : 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      mat.name = `field-${kind}`;
      this.ground.push(mat);
      // Wheat ripples: brighter and darker bands rolling downwind across the field, with the wind's strength.
      if (kind === 'wheat') {
        mat.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, wind);
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec2 vWheatXZ;')
            .replace('#include <project_vertex>', '#include <project_vertex>\nvWheatXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec2 vWheatXZ;\nuniform float uWindTime;\nuniform float uWindAmp;\nuniform vec2 uWindDir;')
            .replace(
              '#include <map_fragment>',
              `#include <map_fragment>
{
  float along = dot( vWheatXZ, uWindDir );
  float wave = sin( along * 0.21 - uWindTime * 1.7 ) * 0.6 + sin( along * 0.47 + dot( vWheatXZ, vec2( -uWindDir.y, uWindDir.x ) ) * 0.13 - uWindTime * 2.6 ) * 0.4;
  diffuseColor.rgb *= 1.0 + wave * ( 0.05 + 0.9 * uWindAmp );
}`,
            );
        };
        mat.customProgramCacheKey = () => 'gta7-wheat-field';
      }
      view.add(g.build(), mat, { name: `field-${kind}`, split: false });
    }
  }

  /**
   * The crop circle's mown ground: its pattern painted as flattened straw, swirled the way the stalks were laid, on a square
   * of canvas that lies a hand over the wheat's slab. Only the pattern shows (alpha-tested), so the wheat round it ripples on.
   */
  private buildCircle(view: CountryView): void {
    const cc = this.circle;
    const side = (cc.radius + 2) * 2;
    const S = 1024;
    const scale = S / side;
    const [c, ctx] = canvas(S, S);
    const at = (x: number, z: number): [number, number] => [(x - cc.cx + side / 2) * scale, (z - cc.cz + side / 2) * scale];
    ctx.beginPath();
    for (const m of cc.mown) {
      const [px, pz] = at(m.cx, m.cz);
      ctx.moveTo(px + m.r1 * scale, pz);
      ctx.arc(px, pz, m.r1 * scale, 0, Math.PI * 2);
      if (m.r0 > 0) {
        ctx.moveTo(px + m.r0 * scale, pz);
        ctx.arc(px, pz, m.r0 * scale, 0, Math.PI * 2, true);
      }
    }
    ctx.fillStyle = '#f5ecc0';
    ctx.fill();
    // Stalks laid round in a swirl: strokes along each point's tangent about the pattern's centre, light and dark.
    ctx.save();
    ctx.clip();
    const [cx, cz] = at(cc.cx, cc.cz);
    for (let k = 0; k < 9000; k++) {
      const h = hashInts(k, 31);
      const a = ((h & 0xffff) / 0xffff) * Math.PI * 2;
      const r = ((h >>> 16) / 0xffff) * cc.radius * scale;
      const x = cx + Math.cos(a) * r;
      const y = cz + Math.sin(a) * r;
      const len = 7 + (hashInts(k, 32) % 9);
      // Along the tangent, with a little turn in it (clockwise on the ground).
      const t = a + Math.PI / 2 + 0.25;
      ctx.strokeStyle = k % 3 === 0 ? 'rgba(170,128,60,0.5)' : k % 3 === 1 ? 'rgba(255,248,214,0.7)' : 'rgba(214,184,110,0.5)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(t) * len, y + Math.sin(t) * len);
      ctx.stroke();
    }
    ctx.restore();
    const tex = toTexture(c, true, false);
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    mat.name = 'crop-circle';
    this.ground.push(mat);
    const geo = new THREE.PlaneGeometry(side, side).rotateX(-Math.PI / 2).translate(cc.cx, SLAB_Y + 0.012, cc.cz);
    view.add(geo, mat, { name: 'crop-circle', split: false });
  }

  /**
   * Corn and sunflowers past the ring: per crop one mesh of every field's block, tops and sides, seen from inside too on
   * the software tier.
   */
  private buildBlocks(view: CountryView): void {
    for (const crop of ['corn', 'sunflower'] as const) {
      const top = new GeoBuilder(false);
      const side = new GeoBuilder(false);
      const h = BLOCK_H[crop]!;
      for (const f of this.fields) {
        if (f.crop !== crop) continue;
        const { minX, minZ, maxX, maxZ } = f.rect;
        const { ux, uz, vx, vz } = frame(f);
        const uv = (x: number, z: number) => [(x * ux + z * uz) / CROP_TILE, (x * vx + z * vz) / CROP_TILE];
        top.quad(minX, h, maxZ, maxX, h, maxZ, maxX, h, minZ, minX, h, minZ, [...uv(minX, maxZ), ...uv(maxX, maxZ), ...uv(maxX, minZ), ...uv(minX, minZ)]);
        // The sides, walked counter-clockwise from above so each faces out; the wall texture is 4 m wide.
        const corners: Array<[number, number]> = [[minX, maxZ], [maxX, maxZ], [maxX, minZ], [minX, minZ]];
        let u = 0;
        for (let k = 0; k < 4; k++) {
          const [ax, az] = corners[k]!;
          const [bx, bz] = corners[(k + 1) % 4]!;
          const len = Math.hypot(bx - ax, bz - az) / 4;
          side.quad(ax, 0, az, bx, 0, bz, bx, h + 0.3, bz, ax, h + 0.3, az, [u, 0, u + len, 0, u + len, 1, u, 1]);
          u += len;
        }
      }
      const faces = view.software ? THREE.DoubleSide : THREE.FrontSide;
      const topMat = new THREE.MeshStandardMaterial({ map: topTexture(crop), roughness: 0.9, side: faces });
      outsideRing(topMat, this.tallRing, `gta7-crop-top`);
      view.add(top.build(), topMat, { name: `crop-top-${crop}`, split: false });
      const sideMat = new THREE.MeshStandardMaterial({ map: wallTexture(crop), alphaTest: 0.5, roughness: 0.9, side: faces });
      outsideRing(sideMat, this.tallRing, `gta7-crop-side`);
      view.add(side.build(), sideMat, { name: `crop-side-${crop}`, split: false });
    }
  }

  private buildPools(view: CountryView, wind: WindUniforms): void {
    const corn = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, map: cornTexture(), alphaTest: 0.5, roughness: 0.86 });
    corn.name = 'county-corn';
    insideRing(corn, this.tallRing, 'gta7-county-corn', wind);
    const wheat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: wheatTexture(), alphaTest: 0.5, roughness: 0.9, side: THREE.DoubleSide });
    wheat.name = 'county-wheat';
    insideRing(wheat, this.wheatRing, 'gta7-county-wheat', wind, (shader) => {
      Object.assign(shader.uniforms, wind);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWindTime;\nuniform float uWindAmp;\nuniform vec2 uWindDir;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  // The ripple the field's ground shows (buildSlabs), the tops leaning downwind with it.
  vec2 at = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;
  float along = dot( at, uWindDir );
  float wave = sin( along * 0.21 - uWindTime * 1.7 ) * 0.6 + sin( along * 0.47 + dot( at, vec2( -uWindDir.y, uWindDir.x ) ) * 0.13 - uWindTime * 2.6 ) * 0.4;
  float k = position.y / ${WHEAT_H.toFixed(2)};
  vec3 lean = vec3( uWindDir.x, 0.0, uWindDir.y ) * ( 0.04 + 1.6 * uWindAmp ) * ( 0.5 + 0.5 * wave ) * k * k;
  transformed += inverse( mat3( modelMatrix * instanceMatrix ) ) * lean;
}`,
      );
    });
    const sun = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    sun.name = 'county-sunflowers';
    const yaw = this.sunYaw;
    insideRing(sun, this.tallRing, 'gta7-county-sunflowers', undefined, (shader) => {
      shader.uniforms.uSunYaw = yaw;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uSunYaw;
// Every head to the sun, give or take a little each: the plant turned about its stem, normals with it.
vec3 sunTurn( vec3 v ) {
  float a = uSunYaw + ( fract( sin( dot( instanceMatrix[ 3 ].xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5 ) * 0.5 - atan( instanceMatrix[ 2 ].x, instanceMatrix[ 2 ].z );
  return vec3( v.x * cos( a ) + v.z * sin( a ), v.y, -v.x * sin( a ) + v.z * cos( a ) );
}`,
        )
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = sunTurn( objectNormal );')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = sunTurn( transformed );');
    });
    this.crops.push(corn, wheat, sun);
    const make = (crop: Crop, geo: THREE.BufferGeometry, mat: THREE.Material, ring: { value: THREE.Vector4 }, capacity: number, shadow: boolean) => {
      const mesh = new THREE.InstancedMesh(geo, mat, capacity);
      mesh.name = `crops-${crop}`;
      mesh.count = 0;
      mesh.visible = false;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      view.moving.add(mesh);
      this.pools.push({ crop, mesh, ring });
    };
    const most = CROP_RING.high;
    make('corn', cornGeometry(), corn, this.tallRing, most.corn, true);
    make('wheat', wheatGeometry(), wheat, this.wheatRing, most.wheat, false);
    make('sunflower', sunflowerGeometry(), sun, this.tallRing, most.sunflower, true);
  }

  /** The tier's ring and pools (CROP_RING); software draws the blocks alone. */
  setTier(ring: CropRing): void {
    this.ring = ring;
    this.cellX = NaN;
  }

  /**
   * Each frame, with the camera at (x, y, z): the sunflowers to the sun (its direction's x and z), the pools refilled on
   * a new cell or when the camera rises past RING_TOP or comes back down.
   */
  update(x: number, y: number, z: number, sunX: number, sunZ: number): void {
    this.sunYaw.value = Math.atan2(sunX, sunZ);
    const cx = Math.floor(x / FIELD_CELL);
    const cz = Math.floor(z / FIELD_CELL);
    const high = y > RING_TOP;
    if (cx === this.cellX && cz === this.cellZ && high === this.high) return;
    this.cellX = cx;
    this.cellZ = cz;
    this.high = high;
    const n = this.near;
    const far = high || x < n.minX || x > n.maxX || z < n.minZ || z > n.maxZ;
    const ox = (cx + 0.5) * FIELD_CELL;
    const oz = (cz + 0.5) * FIELD_CELL;
    this.tallRing.value.set(ox, oz, far ? 0 : this.ring.ring, RING_FADE);
    this.wheatRing.value.set(ox, oz, far ? 0 : this.ring.wheatRing, RING_FADE);
    // Far from every field (the city) with the pools emptied already, there is nothing to refill.
    if (far && this.pools.every((p) => p.mesh.count === 0)) return;
    for (const pool of this.pools) this.fill(pool, far ? 0 : pool.ring.value.z, ox, oz, far ? 0 : this.ring[pool.crop as 'corn' | 'wheat' | 'sunflower']);
  }

  /**
   * Refills `pool` with its plants within `radius` of (ox, oz), at most `cap`, the nearest kept; an empty pool is not
   * drawn, and only the instances it holds go up to the GPU.
   */
  private fill(pool: Pool, radius: number, ox: number, oz: number, cap: number): void {
    const out = cropPlants(this.fields, pool.crop, radius, ox, oz, this.circle);
    if (out.length > cap) out.sort((a, b) => a.d - b.d).length = cap;
    const mesh = pool.mesh;
    out.forEach((o, n) => {
      this.q.setFromAxisAngle(this.up, o.yaw);
      this.m.compose(this.p.set(o.x, 0, o.z), this.q, this.s.set(o.s, o.s * o.h, o.s));
      mesh.setMatrixAt(n, this.m);
      const t = o.tint / 255;
      if (pool.crop === 'corn') this.c.setRGB(0.9 + t * 0.08, 0.93 + t * 0.05, 0.86);
      else if (pool.crop === 'wheat') this.c.setRGB(0.92 + t * 0.12, 0.88 + t * 0.1, 0.8);
      else this.c.setRGB(0.9 + t * 0.1, 0.9 + t * 0.1, 0.9);
      mesh.setColorAt(n, this.c);
    });
    mesh.count = out.length;
    mesh.visible = out.length > 0;
    if (out.length === 0) return;
    for (const a of [mesh.instanceMatrix, mesh.instanceColor!]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, out.length * a.itemSize);
      a.needsUpdate = true;
    }
  }
}
