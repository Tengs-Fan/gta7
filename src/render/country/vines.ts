// Sunset Vineyard's rows (world/country/valley.ts VineSegment), drawn as instances: each run of trellis is one instance of a
// 3 m model (an end post, two leaf walls splayed over a low cap, grapes hanging in the lower half), set on the ground
// under its middle, so a row that follows a contour stands level. The leaves sway on the props' wind from the post's
// top, grown from the ground up as the crops' do (the foliage's own sway starts a metre up and would leave a 2 m vine
// still). The instances are cut into chunks that the view hides past the county's reach, and the soil strips under the
// rows are one static layer in the county's cells. The material joins the fields' crops, which the headlights light by
// their own rule at night (render/lightSprites.ts lightGround).

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { VINE_ROWS, VINE_SEG, type VineSegment, type Vineyard } from '../../world/country/valley';
import { GeoBuilder } from '../geo';
import { fadeNearCamera, type WindUniforms } from '../props';
import { CROP_TILE, cropTexture } from '../textures/ground';
import { canvas, toTexture } from '../textures/misc';
import { WIND_GLSL } from '../wind';
import type { CountryView } from './index';

/** Chunks of this side (m) are hidden, each in one, past the cull's reach. */
const CHUNK = 96;
/** The trellis's post top and the leaf walls' height (m). */
const POST_H = 1.75;
const LEAF_TOP = 1.95;
/** The soil strip under a row: its width (m), and its height over the ground. */
const STRIP_W = 1.3;
const STRIP_Y = 0.025;

/** A vine's leaves and grapes on a transparent ground, its bottom tenth an opaque brown strip for the posts. */
function vineTexture(): THREE.Texture {
  const W = 256;
  const H = 256;
  const [c, ctx] = canvas(W, H);
  ctx.clearRect(0, 0, W, H);
  const rng = new Rng(9106);
  const leaf = (x: number, y: number, s: number, g: number) => {
    ctx.fillStyle = `rgb(${Math.round(g * 0.55)},${g},${Math.round(g * 0.3)})`;
    ctx.beginPath();
    ctx.ellipse(x, y, s, s * 0.78, rng.range(0, Math.PI), 0, Math.PI * 2);
    ctx.fill();
  };
  // A dense green mat of leaves over the top nine tenths, ragged along its upper edge.
  for (let k = 0; k < 150; k++) leaf(rng.range(0, W), rng.range(10, H * 0.9), rng.range(9, 17), rng.int(80, 140));
  for (let k = 0; k < 40; k++) leaf(rng.range(0, W), rng.range(H * 0.3, H * 0.85), rng.range(6, 11), rng.int(130, 175));
  // The bunches, dark purple, hanging in the lower half of the leaves.
  for (let k = 0; k < 7; k++) {
    const x = rng.range(14, W - 14);
    const y = rng.range(H * 0.5, H * 0.76);
    for (let n = 0; n < 9; n++) {
      ctx.fillStyle = n % 3 === 0 ? '#5d2a63' : '#3f1d4a';
      ctx.beginPath();
      ctx.arc(x + rng.range(-5, 5), y + n * 2.6 + rng.range(-1.5, 1.5), rng.range(3.2, 4.6), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // The posts' strip.
  ctx.fillStyle = '#6a4a2c';
  ctx.fillRect(0, H * 0.92, W, H * 0.08);
  return toTexture(c);
}

/** A run of trellis along local +x, centred on the origin at the ground. */
function vineGeometry(): THREE.BufferGeometry {
  const g = new GeoBuilder(true);
  const h = VINE_SEG / 2;
  const white = [1, 1, 1] as const;
  // Leaf cards sample the texture above its post strip (v 0.1 to 1), three leaf tiles along the run, the second card of
  // each side shifted so the two do not repeat.
  const v0 = 0.12;
  const v1 = 1;
  for (const s of [-1, 1]) {
    g.quad(-h, 0.5, s * 0.18, h, 0.5, s * 0.18, h, 1.3, s * 0.44, -h, 1.3, s * 0.44, [0, v0, 3, v0, 3, v1, 0, v1], white);
    g.quad(-h, 1.15, s * 0.42, h, 1.15, s * 0.42, h, LEAF_TOP, s * 0.24, -h, LEAF_TOP, s * 0.24, [0.5, v0, 3.5, v0, 3.5, v1, 0.5, v1], white);
  }
  g.quad(-h, LEAF_TOP, -0.24, h, LEAF_TOP, -0.24, h, LEAF_TOP + 0.02, 0.24, -h, LEAF_TOP + 0.02, 0.24, [0, v0, 3, v0, 3, v1, 0, v1], white);
  // The end post, and the wire along the top, every face on the texture's brown strip.
  const strip = [0.5, 0.04, 0.5, 0.04, 0.5, 0.04, 0.5, 0.04];
  const column = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    g.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, strip, white);
    g.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, strip, white);
    g.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, strip, white);
    g.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, strip, white);
    g.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, strip, white);
  };
  column(-h, -0.3, -0.04, -h + 0.08, POST_H, 0.04);
  column(-h, POST_H - 0.04, -0.012, h, POST_H, 0.012);
  return g.build();
}

/** The vines' material: leaves alpha-tested, dissolving close to the camera, swaying from the ground up on the shared wind. */
function vineMaterial(wind: WindUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ map: vineTexture(), vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9 });
  mat.name = 'vineyard-vines';
  fadeNearCamera(mat);
  const fade = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    fade.call(mat, shader, renderer);
    Object.assign(shader.uniforms, wind);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_GLSL}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  // The wind's own sway at full weight, scaled by how far up the vine this vertex is: a post barely moves, the leaves' tops lean.
  mat4 vineFrame = modelMatrix * instanceMatrix;
  vec3 vineWorld = ( vineFrame * vec4( transformed, 1.0 ) ).xyz;
  float vineK = smoothstep( 0.5, ${LEAF_TOP.toFixed(2)}, transformed.y ) * 2.2;
  transformed += inverse( mat3( vineFrame ) ) * windOffset( vineWorld, 4.5, vineK );
}`,
      );
  };
  mat.customProgramCacheKey = () => 'gta7-vines';
  return mat;
}

export class Vines {
  private readonly chunks: Array<{ mesh: THREE.InstancedMesh; x: number; z: number; r: number }> = [];

  constructor(view: CountryView, vineyard: Vineyard, wind: WindUniforms) {
    const { segments, rise } = vineyard;
    const geo = vineGeometry();
    const mat = vineMaterial(wind);
    view.fields.crops.push(mat);
    const by = new Map<string, VineSegment[]>();
    for (const s of segments) {
      const key = `${Math.floor(s.x / CHUNK)},${Math.floor(s.z / CHUNK)}`;
      let list = by.get(key);
      if (!list) by.set(key, (list = []));
      list.push(s);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const c = new THREE.Color();
    const rng = new Rng(9107);
    for (const list of by.values()) {
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      mesh.name = 'vineyard-rows';
      list.forEach((s, k) => {
        m.compose(new THREE.Vector3(s.x, view.world.baseGround(s.x, s.z), s.z), q.setFromAxisAngle(up, s.yaw), one);
        mesh.setMatrixAt(k, m);
        // Mostly green, a row or two turning gold: each run a little lighter or darker than its neighbour.
        const row = Math.round((Math.hypot((s.x - rise.cx) / rise.rx, (s.z - rise.cz) / rise.rz) - VINE_ROWS.from) / VINE_ROWS.step);
        const gold = row % 7 === 4;
        const t = rng.range(0.86, 1.08);
        mesh.setColorAt(k, gold ? c.setRGB(1.35 * t, 1.05 * t, 0.45 * t) : c.setRGB(0.95 * t, 1.02 * t, 0.9 * t));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      view.group.add(mesh);
      const b = mesh.boundingSphere!;
      this.chunks.push({ mesh, x: b.center.x, z: b.center.z, r: b.radius });
    }
    // The soil under the rows: a strip a run long under each, just over the grass, in the county's cells.
    const soil = new GeoBuilder(false);
    const at = (x: number, z: number) => view.world.baseGround(x, z) + STRIP_Y;
    for (const s of segments) {
      const ax = Math.cos(s.yaw) * (VINE_SEG / 2);
      const az = -Math.sin(s.yaw) * (VINE_SEG / 2);
      const px = -az * (STRIP_W / VINE_SEG);
      const pz = ax * (STRIP_W / VINE_SEG);
      // Out to the left of the way it runs first, so it faces up (the farm drives' strips).
      const p = [[s.x - ax + px, s.z - az + pz], [s.x + ax + px, s.z + az + pz], [s.x + ax - px, s.z + az - pz], [s.x - ax - px, s.z - az - pz]] as const;
      soil.quad(p[0][0], at(...p[0]), p[0][1], p[1][0], at(...p[1]), p[1][1], p[2][0], at(...p[2]), p[2][1], p[3][0], at(...p[3]), p[3][1], p.flatMap(([x, z]) => [x / CROP_TILE, z / CROP_TILE]));
    }
    // The tilled soil of the county's furrows, over the grass.
    const dirt = new THREE.MeshStandardMaterial({ map: cropTexture('soil'), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    view.add(soil.build(), view.city.wet.patch(dirt), { name: 'vineyard-soil' });
  }

  /** Hides the chunks past `far` m from (x, z). */
  cull(x: number, z: number, far: number): void {
    for (const c of this.chunks) c.mesh.visible = Math.hypot(c.x - x, c.z - z) < far + c.r;
  }
}
