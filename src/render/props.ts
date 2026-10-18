// Street furniture and landmarks as instanced meshes, with night lighting,
// live traffic signal bulbs and breakable props.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { smoothstep } from '../core/math';
import { Rng } from '../core/rng';
import { axisOf, type Dir } from '../world/roads';
import { rectContains, type Prop, type PropKind, type Rect } from '../world/layout';
import type { StaticWorld } from '../world/staticWorld';
import { adTexture, AD_COUNT, glowTexture, groundTexture } from './textures';

interface InstanceRef {
  mesh: THREE.InstancedMesh;
  index: number;
  base: THREE.Matrix4;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of prepared) {
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((g.getAttribute('position').count) * 2), 2));
  }
  const m = mergeGeometries(prepared, false);
  if (!m) throw new Error('mergeGeometries failed');
  return m;
}

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function cyl(rt: number, rb: number, h: number, seg: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  g.translate(x, y + h / 2, z);
  return g;
}

/** Foliage dissolves within this distance (m) of the camera, completely nearer than FADE_NEAR. */
export const FOLIAGE_FADE_FAR = 2.5;
const FADE_NEAR = 1.2;

/** Share of foliage fragments at `d` m from the camera that the dissolve keeps (see fadeNearCamera). */
export function foliageKept(d: number): number {
  return smoothstep(FADE_NEAR, FOLIAGE_FADE_FAR, d);
}

/** A tree's canopy: three icosahedra (radius, vertical stretch, centre at scale 1, before the prop's turn). */
const CANOPY = [
  { r: 1.7, sy: 1.1, at: [0, 4.3, 0] },
  { r: 1.25, sy: 1, at: [0.7, 5.3, 0.3] },
  { r: 1.1, sy: 1, at: [-0.6, 5.0, -0.5] },
] as const;
/** A bush: one squashed icosahedron. */
const BUSH = { r: 0.85, scale: [1.2, 0.75, 1.1], at: [0, 0.55, 0] } as const;

/** Points on the faces of three's unit detail-0 icosahedron: a barycentric grid of every face (corners and edges included). */
const ICOSA_POINTS: readonly number[] = (() => {
  const pos = new THREE.IcosahedronGeometry(1, 0).getAttribute('position');
  const out: number[] = [];
  const n = 4;
  for (let f = 0; f < pos.count; f += 3) {
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const a = i / n;
        const b = j / n;
        const c = 1 - a - b;
        for (const axis of ['getX', 'getY', 'getZ'] as const) out.push(pos[axis](f) * a + pos[axis](f + 1) * b + pos[axis](f + 2) * c);
      }
    }
  }
  return out;
})();

/** One icosahedron of a prop's foliage: its radius per axis and centre, at scale 1 before the prop's turn. */
interface FoliagePart {
  scale: readonly [number, number, number];
  at: readonly [number, number, number];
}

function foliageParts(q: Prop): readonly FoliagePart[] {
  if (q.kind === 'tree') return CANOPY.map((c) => ({ scale: [c.r, c.r * c.sy, c.r] as const, at: c.at }));
  if (q.kind === 'bush') return [{ scale: [BUSH.r * BUSH.scale[0], BUSH.r * BUSH.scale[1], BUSH.r * BUSH.scale[2]] as const, at: BUSH.at }];
  return [];
}

/** PropsView.standard's placement of a point given in a prop's frame: turned by rot about Y, scaled, at the prop. */
function placed(q: Prop, x: number, y: number, z: number): [number, number, number] {
  const cos = Math.cos(q.rot);
  const sin = Math.sin(q.rot);
  return [q.x + (x * cos + z * sin) * q.scale, q.y + y * q.scale, q.z + (z * cos - x * sin) * q.scale];
}

/** Spheres round the foliage of a tree or bush (none for other props), in world space: every leaf lies inside one. */
export function foliageSpheres(q: Prop): Array<{ x: number; y: number; z: number; r: number }> {
  return foliageParts(q).map(({ scale, at }) => {
    const [x, y, z] = placed(q, at[0], at[1], at[2]);
    return { x, y, z, r: Math.max(...scale) * q.scale };
  });
}

/**
 * Points spread over the faces of a tree's or bush's foliage (none for other props), in world space,
 * no more than a quarter of a face's edge apart: where the camera could see leaves dissolving.
 */
export function foliagePoints(q: Prop): number[] {
  const out: number[] = [];
  for (const { scale, at } of foliageParts(q)) {
    for (let k = 0; k < ICOSA_POINTS.length; k += 3) out.push(...placed(q, at[0] + ICOSA_POINTS[k]! * scale[0], at[1] + ICOSA_POINTS[k + 1]! * scale[1], at[2] + ICOSA_POINTS[k + 2]! * scale[2]));
  }
  return out;
}

/**
 * Makes an instanced foliage material dissolve close to the camera: fragments within
 * FOLIAGE_FADE_FAR of it are thinned out by a 4x4 Bayer dither (all of them nearer than 1.2 m),
 * so a canopy the camera pushes into turns see-through instead of filling the screen. Opaque, so no
 * sorting and no extra draws; shadows come from the default depth material and are unaffected.
 */
function fadeNearCamera(mat: THREE.Material): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFadeWorld;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vec4 fadeWorld = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
fadeWorld = batchingMatrix * fadeWorld;
#endif
#ifdef USE_INSTANCING
fadeWorld = instanceMatrix * fadeWorld;
#endif
vFadeWorld = ( modelMatrix * fadeWorld ).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vFadeWorld;
float fadeBayer4( vec2 frag ) {
  const float m[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
  ivec2 p = ivec2( mod( floor( frag ), 4.0 ) );
  return ( m[ p.x + p.y * 4 ] + 0.5 ) / 16.0;
}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
{
  float fadeD = distance( vFadeWorld, cameraPosition );
  if ( fadeD < ${FOLIAGE_FADE_FAR.toFixed(2)} && fadeBayer4( gl_FragCoord.xy ) >= smoothstep( ${FADE_NEAR.toFixed(2)}, ${FOLIAGE_FADE_FAR.toFixed(2)}, fadeD ) ) discard;
}`,
      );
  };
}

const BEAM_LENGTH = 90;
const GLOW_COLOR = new THREE.Color(0xffe6b0);

type Rgb = readonly [number, number, number];

/**
 * Coloured lamps (signal bulbs, aircraft warning lights), lit. ACES tone-maps a lamp far above 1 to
 * a near-white core, so with bloom each one's luminance stays above the bloom threshold (2.6) and
 * the halo round it carries the colour (the reds lean a little orange to get there without a halo
 * twice as strong as the green's). Without bloom (Low, or no half-float target) only that core is
 * drawn, so they stay where ACES keeps the hue: red reads red and green green, not white and peach.
 */
const LAMPS: Readonly<Record<'glow' | 'flat', { red: Rgb; yellow: Rgb; green: Rgb; warning: Rgb }>> = {
  glow: { red: [9.5, 1.1, 0.22], yellow: [6, 3.6, 0.07], green: [0.07, 5.5, 2.4], warning: [9.5, 1.1, 0.22] },
  flat: { red: [1, 0.02, 0.01], yellow: [1, 0.42, 0.01], green: [0.01, 0.7, 0.22], warning: [1.1, 0.02, 0.015] },
};
/**
 * The Ferris wheel's lights: 64 bulbs round the rim, alternately on its front and back tube, standing
 * proud of the tube (centred FERRIS_BULB_Z out, the tubes' centre lines being 1.6 out with a 0.3 m
 * radius) so that a viewer sees the whole bulb rather than a sliver. Each is a saturated core (ACES
 * keeps its hue, as on Low) with its own additive halo FERRIS_HALO m across (never under
 * FERRIS_HALO_MIN_PX pixels), so the colour no longer hangs on the bloom pass catching a 2-3 px cap.
 */
const FERRIS_R = 22;
const FERRIS_LIGHTS = 64;
const FERRIS_BULB_Z = 1.95;
const FERRIS_BULB_R = 0.26;
const FERRIS_HALO = 1.5;
const FERRIS_HALO_MIN_PX = 3;
/** The halo's strength against its core: under the bloom threshold, so it does not flicker in and out. */
const FERRIS_HALO_I = 0.9;

const BEAM_VS = /* glsl */ `
varying float vT;
varying vec3 vNormalV;
varying vec3 vViewV;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  // Both beams run along local +-X from the lantern: 0 there, 1 at the tip.
  vT = abs( position.x ) / ${BEAM_LENGTH.toFixed(1)};
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  vNormalV = normalize( normalMatrix * normal );
  vViewV = -mvPosition.xyz;
  vWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const BEAM_FS = /* glsl */ `
uniform float uNight;
uniform float uTime;
uniform vec3 uColor;
varying float vT;
varying vec3 vNormalV;
varying vec3 vViewV;
varying vec3 vWorld;
#include <fog_pars_fragment>
float beamHash( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float beamNoise( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( beamHash( i ), beamHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( beamHash( i + vec3( 0, 1, 0 ) ), beamHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
              mix( mix( beamHash( i + vec3( 0, 0, 1 ) ), beamHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( beamHash( i + vec3( 0, 1, 1 ) ), beamHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
void main() {
  // Brightest where the cone faces the viewer, fading to nothing at its silhouette (no hard outline)
  // and along its length; end-on the surface is edge-on, so there is no disc.
  float facing = abs( dot( normalize( vNormalV ), normalize( vViewV ) ) );
  float a = uNight * 0.35 * pow( 1.0 - clamp( vT, 0.0, 1.0 ), 1.5 ) * facing * facing;
  // Faint dust drifting through the light.
  a *= 0.8 + 0.2 * beamNoise( vWorld * 0.35 + vec3( 0.0, uTime * 0.35, uTime * 0.2 ) );
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      a *= exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      a *= 1.0 - smoothstep( fogNear, fogFar, vFogDepth );
    #endif
  #endif
  gl_FragColor = vec4( uColor, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Makes an instanced material discard fragments whose world x / z fall outside the instance's `aClip`
 * rectangle (min x, min z, max x, max z): a light pool stays on the deck or the land its lamp stands
 * on, at no cost and without distorting its falloff.
 */
function clipToRect(mat: THREE.Material): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aClip;\nvarying vec4 vClipRect;\nvarying vec2 vClipXZ;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vec4 clipWorld = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
clipWorld = instanceMatrix * clipWorld;
#endif
vClipXZ = ( modelMatrix * clipWorld ).xz;
vClipRect = aClip;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vClipRect;\nvarying vec2 vClipXZ;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
if ( vClipXZ.x < vClipRect.x || vClipXZ.y < vClipRect.y || vClipXZ.x > vClipRect.z || vClipXZ.y > vClipRect.w ) discard;`,
      );
  };
  mat.customProgramCacheKey = () => 'gta7-clip-rect';
}

export class PropsView {
  readonly group = new THREE.Group();
  private readonly refs = new Map<number, InstanceRef[]>();
  private readonly bulbMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
  private readonly poolMat: THREE.MeshBasicMaterial;
  private signalBulbs: THREE.InstancedMesh | null = null;
  private signalProps: Prop[] = [];
  private signalPropIndex: number[] = [];
  private readonly brokenSignals = new Set<number>();
  private ferris: { wheel: THREE.Group; gondolas: THREE.InstancedMesh; lights: THREE.InstancedMesh; halos: THREE.Points; x: number; y: number; z: number; rot: number } | null = null;
  private lighthouseBeam: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private lighthouseGlow: THREE.Sprite | null = null;
  private antennaLights: THREE.InstancedMesh | null = null;
  private readonly antennaMat = new THREE.MeshBasicMaterial({ color: 0x220000 });
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpC = new THREE.Color();
  /** Whether a bloom pass draws halos round bright lights, which picks the coloured lamps' colours (see LAMPS). */
  private glow = true;

  constructor(private readonly world: StaticWorld) {
    this.group.name = 'props';
    this.poolMat = new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0xffc27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    clipToRect(this.poolMat);
    const byKind = new Map<PropKind, number[]>();
    world.layout.props.forEach((p, i) => {
      let l = byKind.get(p.kind);
      if (!l) {
        l = [];
        byKind.set(p.kind, l);
      }
      l.push(i);
    });
    const get = (k: PropKind) => byKind.get(k) ?? [];

    this.buildTrees(get('tree'), get('bush'));
    this.buildPalms(get('palm'));
    this.buildLamps(get('lamp'));
    this.buildSignals(get('signal'));
    this.buildSimple(get('hydrant'), merged([cyl(0.17, 0.2, 0.62, 8), new THREE.SphereGeometry(0.16, 8, 6).translate(0, 0.65, 0), cyl(0.06, 0.06, 0.3, 6, 0, 0.32, 0).rotateZ(Math.PI / 2).translate(0.3, 0.1, 0)]), new THREE.MeshStandardMaterial({ color: 0xc0281c, roughness: 0.5 }));
    this.buildSimple(get('bench'), merged([box(1.8, 0.08, 0.45, 0, 0.45, 0), box(1.8, 0.4, 0.06, 0, 0.75, -0.2), box(0.08, 0.45, 0.4, -0.8, 0.22, 0), box(0.08, 0.45, 0.4, 0.8, 0.22, 0)]), new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.85 }));
    this.buildSimple(get('bin'), cyl(0.3, 0.26, 1.0, 10), new THREE.MeshStandardMaterial({ color: 0x1e4d2b, roughness: 0.7, metalness: 0.2 }));
    this.buildContainers(get('container'));
    for (const i of get('fountain')) this.buildFountain(world.layout.props[i]!);
    for (const i of get('crane')) this.buildCrane(world.layout.props[i]!);
    for (const i of get('lighthouse')) this.buildLighthouse(world.layout.props[i]!);
    for (const i of get('ferris')) this.buildFerris(world.layout.props[i]!);
    for (const i of get('boat')) this.buildBoat(world.layout.props[i]!);
    get('billboard').forEach((i, k) => this.buildBillboard(world.layout.props[i]!, k));
    this.buildRoofProps();
  }

  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, props: number[], matrixFor: (p: Prop, m: THREE.Matrix4) => void, opts: { shadow?: boolean; color?: (p: Prop, c: THREE.Color) => void; track?: boolean } = {}): THREE.InstancedMesh | null {
    if (props.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, props.length);
    mesh.castShadow = opts.shadow ?? true;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    props.forEach((pi, k) => {
      const p = this.world.layout.props[pi]!;
      matrixFor(p, m);
      mesh.setMatrixAt(k, m);
      if (opts.color) {
        opts.color(p, c);
        mesh.setColorAt(k, c);
      }
      if (opts.track ?? true) {
        let l = this.refs.get(pi);
        if (!l) {
          l = [];
          this.refs.set(pi, l);
        }
        l.push({ mesh, index: k, base: m.clone() });
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    return mesh;
  }

  private static standard(p: Prop, m: THREE.Matrix4): void {
    m.compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot), new THREE.Vector3(p.scale, p.scale, p.scale));
  }

  private buildSimple(props: number[], geo: THREE.BufferGeometry, mat: THREE.Material): void {
    this.makeInstanced(geo, mat, props, PropsView.standard);
  }

  private buildTrees(trees: number[], bushes: number[]): void {
    const rng = new Rng(77);
    const trunk = cyl(0.16, 0.26, 3.2, 6);
    const foliage = merged(CANOPY.map((c) => new THREE.IcosahedronGeometry(c.r, 0).scale(1, c.sy, 1).translate(c.at[0], c.at[1], c.at[2])));
    this.makeInstanced(trunk, new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 0.95 }), trees, PropsView.standard);
    const leaves = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    fadeNearCamera(leaves);
    this.makeInstanced(foliage, leaves, trees, PropsView.standard, {
      color: (_p, c) => c.setHSL(0.26 + rng.range(-0.04, 0.05), rng.range(0.45, 0.65), rng.range(0.24, 0.36)),
    });
    const bush = new THREE.IcosahedronGeometry(BUSH.r, 0).scale(BUSH.scale[0], BUSH.scale[1], BUSH.scale[2]).translate(BUSH.at[0], BUSH.at[1], BUSH.at[2]);
    const bushMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    fadeNearCamera(bushMat);
    this.makeInstanced(bush, bushMat, bushes, PropsView.standard, {
      color: (_p, c) => c.setHSL(0.27 + rng.range(-0.03, 0.04), 0.5, rng.range(0.22, 0.32)),
      shadow: false,
    });
  }

  private buildPalms(palms: number[]): void {
    const rng = new Rng(78);
    const trunk = merged([cyl(0.14, 0.24, 8.5, 7), cyl(0.3, 0.3, 0.5, 7, 0, 8.3, 0)]);
    const fronds: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 8; i++) {
      const f = new THREE.BoxGeometry(0.5, 0.05, 3.4);
      f.translate(0, 0, 1.7);
      f.rotateX(0.45 + (i % 2) * 0.25);
      f.rotateY((i / 8) * Math.PI * 2);
      f.translate(0, 8.7, 0);
      fronds.push(f);
    }
    this.makeInstanced(trunk, new THREE.MeshStandardMaterial({ color: 0x8b6b4a, roughness: 0.95 }), palms, PropsView.standard);
    const frondMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide });
    fadeNearCamera(frondMat);
    this.makeInstanced(merged(fronds), frondMat, palms, PropsView.standard, {
      color: (_p, c) => c.setHSL(0.28 + rng.range(-0.03, 0.03), 0.55, rng.range(0.26, 0.34)),
    });
  }

  /**
   * Where a lamp's light pool may lie: the deck its pole stands on, else the land (not the sea or the
   * sloping beach, which lie below it). The pool is a flat sheet at the pole's foot, so past that it
   * would hang in the air.
   */
  poolClip(p: Prop): Rect {
    const L = this.world.layout;
    const deck = L.decks.find((d) => rectContains(d.rect, p.x, p.z));
    if (deck) return deck.rect;
    const b = L.bounds;
    return { minX: b.landMinX, minZ: b.landMinZ, maxX: b.beachStartX, maxZ: b.landMaxZ };
  }

  private buildLamps(lamps: number[]): void {
    const pole = merged([cyl(0.07, 0.11, 6.5, 6), box(0.08, 0.08, 1.7, 0, 6.45, 0.8), box(0.42, 0.14, 0.6, 0, 6.38, 1.55)]);
    this.makeInstanced(pole, new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5, metalness: 0.6 }), lamps, PropsView.standard);
    const bulbGeo = box(0.32, 0.04, 0.46, 0, 6.29, 1.55);
    this.makeInstanced(bulbGeo, this.bulbMat, lamps, PropsView.standard, { shadow: false });
    const pool = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    // Per pool: the world rectangle (min x, min z, max x, max z) outside which it draws nothing (poolClip).
    const clip = new Float32Array(lamps.length * 4);
    lamps.forEach((pi, k) => {
      const r = this.poolClip(this.world.layout.props[pi]!);
      clip.set([r.minX, r.minZ, r.maxX, r.maxZ], k * 4);
    });
    pool.setAttribute('aClip', new THREE.InstancedBufferAttribute(clip, 4));
    this.makeInstanced(pool, this.poolMat, lamps, (p, m) => {
      const fx = Math.sin(p.rot);
      const fz = Math.cos(p.rot);
      m.compose(new THREE.Vector3(p.x + fx * 1.6, p.y + 0.04, p.z + fz * 1.6), new THREE.Quaternion(), new THREE.Vector3(13, 1, 13));
    }, { shadow: false });
  }

  private buildSignals(signals: number[]): void {
    const L = this.world.layout;
    const pole = merged([cyl(0.09, 0.11, 5.2, 6), box(0.36, 1.05, 0.28, 0, 4.55, 0.05), box(0.42, 0.06, 0.36, 0, 5.1, 0.05)]);
    this.makeInstanced(pole, new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.6, metalness: 0.4 }), signals, PropsView.standard);
    this.signalProps = signals.map((i) => L.props[i]!);
    this.signalPropIndex = signals;
    // Three bulbs per signal.
    // Low-poly bulbs: there are three per signal head, citywide.
    const bulb = new THREE.IcosahedronGeometry(0.11, 0);
    const mesh = new THREE.InstancedMesh(bulb, new THREE.MeshBasicMaterial({ color: 0xffffff }), signals.length * 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    signals.forEach((pi, k) => {
      const p = L.props[pi]!;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot);
      for (let b = 0; b < 3; b++) {
        v.set(0, 4.88 - b * 0.33, 0.21).applyQuaternion(q);
        m.makeTranslation(p.x + v.x, p.y + v.y, p.z + v.z);
        mesh.setMatrixAt(k * 3 + b, m);
        mesh.setColorAt(k * 3 + b, new THREE.Color(0x111111));
        // Tracked with the pole (whose refs entry exists by now) so breakProp hides them and restoreAll restores them.
        this.refs.get(pi)?.push({ mesh, index: k * 3 + b, base: m.clone() });
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.signalBulbs = mesh;
  }

  private buildContainers(list: number[]): void {
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ map: groundTexture('metal', 9), roughness: 0.7, metalness: 0.3 });
    this.makeInstanced(geo, mat, list, (p, m) => m.compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion(), new THREE.Vector3(p.w, p.h, p.d)), { color: (p, c) => c.setHex(p.color) });
  }

  private buildFountain(p: Prop): void {
    const g = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: 0xc8c2b4, roughness: 0.9 });
    // The basin wall, lathed: up its outer face, across a 0.3 m rim and down the inner face to just under
    // the water, so the far side shows its inner face and rim from outside (an open, one-sided ring
    // showed nothing there). The water's edge tucks under the inner face.
    const ring = new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(3.4, 0), new THREE.Vector2(3.3, 0.7), new THREE.Vector2(3.0, 0.7), new THREE.Vector2(3.0, 0.45)], 24), stone);
    ring.name = 'fountainBasin';
    const water = new THREE.Mesh(new THREE.CircleGeometry(3.02, 24).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3f8fb8, roughness: 0.1, metalness: 0.1 }));
    water.position.y = 0.5;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 2.2, 10), stone);
    col.position.y = 1.1;
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 0.4, 0.4, 14), stone);
    bowl.position.y = 2.2;
    g.add(ring, water, col, bowl);
    g.position.set(p.x, p.y, p.z);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.group.add(g);
  }

  private buildCrane(p: Prop): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0xe0a21a, roughness: 0.6, metalness: 0.3 });
    const parts: THREE.BufferGeometry[] = [];
    for (const [lx, lz] of [[-6, -5], [6, -5], [-6, 5], [6, 5]] as const) parts.push(box(1.0, 30, 1.0, lx, 15, lz));
    parts.push(box(13.2, 1.6, 1.4, 0, 29, -5), box(13.2, 1.6, 1.4, 0, 29, 5), box(1.4, 1.6, 11.4, -6, 29, 0), box(1.4, 1.6, 11.4, 6, 29, 0));
    parts.push(box(2.2, 2.0, 46, 0, 31.6, 12), box(3, 3, 3, 0, 27.5, 3.5));
    const mesh = new THREE.Mesh(merged(parts), mat);
    mesh.position.set(p.x, 0, p.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private buildLighthouse(p: Prop): void {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#f2f2f2' : '#c0302a';
      ctx.fillRect(0, i * 16, 16, 16);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 3.4, 24, 18), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
    tower.position.set(p.x, p.y + 12, p.z);
    tower.castShadow = true;
    const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 2.4, 12), new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffe9a0, emissiveIntensity: 0.5, roughness: 0.2 }));
    lantern.position.set(p.x, p.y + 25.2, p.z);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(2.1, 2.2, 12), new THREE.MeshStandardMaterial({ color: 0x8f1f1a, roughness: 0.5 }));
    cap.position.set(p.x, p.y + 27.5, p.z);
    // Two opposite beams in one mesh: open cones from the lantern (apex) out along local +-X.
    const cone = new THREE.ConeGeometry(5, BEAM_LENGTH, 16, 1, true);
    cone.translate(0, -BEAM_LENGTH / 2, 0);
    cone.rotateZ(Math.PI / 2);
    const beamGeo = mergeGeometries([cone, cone.clone().rotateY(Math.PI)], false);
    if (!beamGeo) throw new Error('mergeGeometries failed');
    // Only the near side of each cone draws (FrontSide): no double layer and no disc seen end-on.
    const beamMat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VS,
      fragmentShader: BEAM_FS,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uNight: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color(0xfff1c8) } }]),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
      fog: true,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.name = 'lighthouseBeam';
    beam.position.set(p.x, p.y + 25.2, p.z);
    beam.visible = false;
    this.lighthouseBeam = beam;
    // A halo round the lantern; bright lights carry through the haze, so it is not fogged.
    const glowMat = new THREE.SpriteMaterial({ map: glowTexture(), color: GLOW_COLOR, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0 });
    const glow = new THREE.Sprite(glowMat);
    glow.name = 'lighthouseGlow';
    glow.position.set(p.x, p.y + 25.2, p.z);
    glow.scale.set(11, 11, 1);
    glow.visible = false;
    // It flares as a beam sweeps across the viewer (end-on the beam itself is edge-on and unseen).
    glow.onBeforeRender = (_r, _s, camera) => {
      const e = camera.matrixWorld.elements;
      const dx = e[12]! - glow.position.x;
      const dz = e[14]! - glow.position.z;
      const r = beam.rotation.y;
      // Local +-X turned by r about Y points along +-(cos r, -sin r).
      const along = Math.abs(dx * Math.cos(r) - dz * Math.sin(r)) / (Math.hypot(dx, dz) || 1);
      glowMat.color.copy(GLOW_COLOR).multiplyScalar(1 + 3 * smoothstep(0.94, 1, along));
    };
    this.lighthouseGlow = glow;
    this.group.add(tower, lantern, cap, beam, glow);
  }

  private buildFerris(p: Prop): void {
    const R = FERRIS_R;
    const hubY = p.y + R + 4;
    const steel = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4, metalness: 0.5 });
    const wheel = new THREE.Group();
    const rimParts: THREE.BufferGeometry[] = [];
    for (const z of [-1.6, 1.6]) {
      rimParts.push(new THREE.TorusGeometry(R, 0.3, 6, 64).translate(0, 0, z));
      rimParts.push(new THREE.TorusGeometry(R * 0.35, 0.2, 6, 24).translate(0, 0, z));
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const s = new THREE.BoxGeometry(0.14, R, 0.14).translate(0, R / 2, z);
        s.rotateZ(a);
        rimParts.push(s);
      }
    }
    rimParts.push(new THREE.CylinderGeometry(0.9, 0.9, 4.2, 12).rotateX(Math.PI / 2));
    const rim = new THREE.Mesh(merged(rimParts), steel);
    rim.castShadow = true;
    wheel.add(rim);
    const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(FERRIS_BULB_R, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), FERRIS_LIGHTS);
    lights.name = 'ferrisLights';
    const haloPos = new Float32Array(FERRIS_LIGHTS * 3);
    for (let i = 0; i < FERRIS_LIGHTS; i++) {
      const a = (i / FERRIS_LIGHTS) * Math.PI * 2;
      const side = i % 2 === 0 ? 1 : -1;
      this.tmpM.makeTranslation(Math.cos(a) * R, Math.sin(a) * R, side * FERRIS_BULB_Z);
      lights.setMatrixAt(i, this.tmpM);
      lights.setColorAt(i, new THREE.Color(0x222222));
      // The halo sits at the bulb's outer face, so the tube behind does not cut into it.
      haloPos.set([Math.cos(a) * R, Math.sin(a) * R, side * (FERRIS_BULB_Z + FERRIS_BULB_R)], i * 3);
    }
    wheel.add(lights);
    const haloGeo = new THREE.BufferGeometry();
    haloGeo.setAttribute('position', new THREE.BufferAttribute(haloPos, 3));
    haloGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(FERRIS_LIGHTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    // The lamp pools' glow texture: on the GPU from the first frame, so lighting up at night uploads nothing.
    const haloMat = new THREE.PointsMaterial({ size: FERRIS_HALO, map: this.poolMat.map, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    haloMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>\ngl_PointSize = max( gl_PointSize, ${FERRIS_HALO_MIN_PX.toFixed(1)} );`);
    };
    haloMat.customProgramCacheKey = () => 'gta7-ferris-halo';
    const halos = new THREE.Points(haloGeo, haloMat);
    halos.name = 'ferrisHalos';
    wheel.add(halos);
    wheel.position.set(p.x, hubY, p.z);
    wheel.rotation.y = p.rot;
    this.group.add(wheel);
    const gondolas = new THREE.InstancedMesh(merged([box(2.2, 2.0, 2.4, 0, -1.6, 0), box(0.1, 0.8, 0.1, 0, -0.3, 0)]), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }), 16);
    for (let i = 0; i < 16; i++) gondolas.setColorAt(i, new THREE.Color().setHSL(i / 16, 0.7, 0.55));
    gondolas.castShadow = true;
    this.group.add(gondolas);
    // A-frame supports.
    const legs: THREE.BufferGeometry[] = [];
    for (const z of [-3.2, 3.2]) {
      for (const sx of [-1, 1]) {
        const len = Math.hypot(R * 0.55, R + 4);
        const g = new THREE.BoxGeometry(0.6, len, 0.6).translate(0, len / 2, 0);
        g.rotateZ(sx * Math.atan2(R * 0.55, R + 4));
        g.translate(-sx * R * 0.55, 0, z);
        legs.push(g);
      }
    }
    const legMesh = new THREE.Mesh(merged(legs), steel);
    legMesh.position.set(p.x, p.y, p.z);
    legMesh.rotation.y = p.rot;
    legMesh.castShadow = true;
    this.group.add(legMesh);
    this.ferris = { wheel, gondolas, lights, halos, x: p.x, y: hubY, z: p.z, rot: p.rot };
  }

  private buildBoat(p: Prop): void {
    const shape = new THREE.Shape();
    shape.moveTo(-5, 0.6);
    shape.lineTo(4, 0.6);
    shape.quadraticCurveTo(6.5, 0.6, 7, 1.8);
    shape.lineTo(-5, 1.8);
    shape.lineTo(-5, 0.6);
    const hull = new THREE.ExtrudeGeometry(shape, { depth: 2.6, bevelEnabled: false });
    hull.translate(0, -0.6, -1.3);
    const g = new THREE.Group();
    const hullMesh = new THREE.Mesh(hull, new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.4 }));
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.4, 2.0), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 }));
    cabin.position.set(-0.5, 1.8, 0);
    g.add(hullMesh, cabin);
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = p.rot + Math.PI / 2;
    this.group.add(g);
  }

  private buildBillboard(p: Prop, k: number): void {
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.6, metalness: 0.5 });
    const legs = new THREE.Mesh(merged([cyl(0.25, 0.3, 9, 8, -4.5, 0, 0), cyl(0.25, 0.3, 9, 8, 4.5, 0, 0), box(11, 0.3, 0.3, 0, 4.6, 0)]), metal);
    const tex = adTexture(k % AD_COUNT);
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.6 });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(12, 6, 0.3), [metal, metal, metal, metal, mat, mat]);
    panel.position.y = 8.2;
    legs.castShadow = true;
    panel.castShadow = true;
    g.add(legs, panel);
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = p.rot;
    this.group.add(g);
    this.adMaterials.push(mat);
  }

  private readonly adMaterials: THREE.MeshStandardMaterial[] = [];

  private buildRoofProps(): void {
    const all = this.world.layout.buildings.flatMap((b) => b.roofProps);
    const ac = all.filter((r) => r.kind === 'ac');
    const tanks = all.filter((r) => r.kind === 'tank');
    const antennas = all.filter((r) => r.kind === 'antenna');
    const boards = all.filter((r) => r.kind === 'billboard');
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, list: typeof all, scaleY = true) => {
      if (list.length === 0) return null;
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((r, i) => {
        this.tmpM.compose(new THREE.Vector3(r.x, r.y, r.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.rot), new THREE.Vector3(r.w, scaleY ? r.h : 1, r.d));
        mesh.setMatrixAt(i, this.tmpM);
      });
      mesh.castShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      return mesh;
    };
    inst(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ map: groundTexture('metal', 4), color: 0xb0b4b8, roughness: 0.6, metalness: 0.3 }), ac);
    inst(merged([cyl(0.5, 0.5, 0.8, 10), new THREE.ConeGeometry(0.55, 0.25, 10).translate(0, 0.92, 0), cyl(0.04, 0.04, 0.2, 4, 0.4, -0.2, 0)]), new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 }), tanks);
    inst(box(1, 1, 1, 0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.5, metalness: 0.6 }), antennas);
    if (antennas.length > 0) {
      const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 8, 6), this.antennaMat, antennas.length);
      antennas.forEach((r, i) => {
        this.tmpM.makeTranslation(r.x, r.y + r.h + 0.2, r.z);
        lights.setMatrixAt(i, this.tmpM);
      });
      lights.instanceMatrix.needsUpdate = true;
      lights.computeBoundingSphere();
      this.group.add(lights);
      this.antennaLights = lights;
    }
    boards.forEach((r, k) => {
      const tex = adTexture((k + 2) % AD_COUNT);
      const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.6 });
      const frame = new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.6, metalness: 0.4 });
      const panel = new THREE.Mesh(new THREE.BoxGeometry(r.w, r.h, 0.3), [frame, frame, frame, frame, mat, mat]);
      panel.position.set(r.x, r.y + 1.6 + r.h / 2, r.z);
      panel.rotation.y = r.rot;
      panel.castShadow = true;
      const legs = new THREE.Mesh(merged([box(0.2, 1.7, 0.2, -r.w / 3, 0.85, 0), box(0.2, 1.7, 0.2, r.w / 3, 0.85, 0)]), frame);
      legs.position.set(r.x, r.y, r.z);
      legs.rotation.y = r.rot;
      this.group.add(panel, legs);
      this.adMaterials.push(mat);
    });
  }

  /** Knocks over a breakable prop in the given direction. */
  breakProp(index: number, dirX: number, dirZ: number): void {
    const refs = this.refs.get(index);
    if (!refs) return;
    const p = this.world.layout.props[index]!;
    const l = Math.hypot(dirX, dirZ) || 1;
    const axis = new THREE.Vector3(dirZ / l, 0, -dirX / l);
    const fall = new THREE.Matrix4().makeRotationAxis(axis, Math.PI / 2 - 0.08);
    const toOrigin = new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z);
    const back = new THREE.Matrix4().makeTranslation(p.x, p.y + (p.kind === 'lamp' || p.kind === 'signal' ? 0.15 : 0.2), p.z);
    const hide = p.kind === 'hydrant';
    for (const r of refs) {
      let m: THREE.Matrix4;
      if (hide || r.mesh.material === this.poolMat || r.mesh.material === this.bulbMat || r.mesh === this.signalBulbs) m = new THREE.Matrix4().makeScale(0, 0, 0);
      else m = back.clone().multiply(fall).multiply(toOrigin).multiply(r.base);
      r.mesh.setMatrixAt(r.index, m);
      r.mesh.instanceMatrix.needsUpdate = true;
    }
    if (p.kind === 'signal') this.brokenSignals.add(index);
  }

  /** Whether bloom draws halos round bright lights (GameRenderer.setQuality): without it the coloured lamps use LAMPS.flat. */
  setGlow(on: boolean): void {
    this.glow = on;
  }

  /** Puts every knocked-over prop back in place (new game). */
  restoreAll(): void {
    for (const refs of this.refs.values()) {
      for (const r of refs) {
        r.mesh.setMatrixAt(r.index, r.base);
        r.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.brokenSignals.clear();
  }

  /**
   * `time` drives the decorative animation only. `signalTime` must be the simulation clock
   * (sim.time) so the bulbs show the phase that drivers and pedestrians obey.
   */
  update(time: number, night: number, signalTime: number): void {
    // Lamps.
    const k = night;
    this.bulbMat.color.setRGB(0.25 + k * 7.5, 0.24 + k * 6, 0.22 + k * 3.8);
    this.poolMat.opacity = k * 0.42;
    for (const m of this.adMaterials) m.emissiveIntensity = 0.12 + k * 1.1;
    // Signals.
    const lamps = LAMPS[this.glow ? 'glow' : 'flat'];
    const bulbs = this.signalBulbs;
    if (bulbs) {
      const roads = this.world.roads;
      const off = 0.07;
      this.signalProps.forEach((p, i) => {
        const broken = this.brokenSignals.has(this.signalPropIndex[i]!);
        const st = broken ? 'off' : roads.signalState(p.node, axisOf(p.dir as Dir), signalTime);
        bulbs.setColorAt(i * 3, st === 'red' ? this.tmpC.setRGB(...lamps.red) : this.tmpC.setRGB(off + 0.05, off, off));
        bulbs.setColorAt(i * 3 + 1, st === 'yellow' ? this.tmpC.setRGB(...lamps.yellow) : this.tmpC.setRGB(off + 0.05, off, off));
        bulbs.setColorAt(i * 3 + 2, st === 'green' ? this.tmpC.setRGB(...lamps.green) : this.tmpC.setRGB(off, off + 0.05, off));
      });
      if (bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true;
    }
    // Ferris wheel.
    const f = this.ferris;
    if (f) {
      const ang = time * 0.06;
      f.wheel.rotation.z = ang;
      const R = FERRIS_R;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.rot);
      for (let i = 0; i < 16; i++) {
        const a = ang + (i / 16) * Math.PI * 2;
        const local = new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0).applyQuaternion(q);
        this.tmpM.compose(new THREE.Vector3(f.x + local.x, f.y + local.y, f.z + local.z), q, new THREE.Vector3(1, 1, 1));
        f.gondolas.setMatrixAt(i, this.tmpM);
      }
      f.gondolas.instanceMatrix.needsUpdate = true;
      f.gondolas.computeBoundingSphere();
      const lit = night > 0.2;
      const halo = f.halos.geometry.getAttribute('color') as THREE.BufferAttribute;
      for (let i = 0; i < FERRIS_LIGHTS; i++) {
        const hue = (i / FERRIS_LIGHTS + time * 0.05) % 1;
        // The same saturated core on every tier, with or without bloom, and its own halo.
        if (lit) this.tmpC.setHSL(hue, 1, 0.5);
        else this.tmpC.setRGB(0.15, 0.15, 0.15);
        f.lights.setColorAt(i, this.tmpC);
        const k = lit ? FERRIS_HALO_I : 0;
        halo.setXYZ(i, this.tmpC.r * k, this.tmpC.g * k, this.tmpC.b * k);
      }
      if (f.lights.instanceColor) f.lights.instanceColor.needsUpdate = true;
      halo.needsUpdate = true;
      f.halos.visible = lit;
    }
    if (this.lighthouseBeam) {
      const beam = this.lighthouseBeam;
      beam.rotation.y = time * 0.9;
      beam.material.uniforms.uNight!.value = night;
      beam.material.uniforms.uTime!.value = time;
      beam.visible = night > 0.05;
    }
    if (this.lighthouseGlow) {
      this.lighthouseGlow.material.opacity = Math.min(1, night * 0.9);
      this.lighthouseGlow.visible = night > 0.05;
    }
    if (this.antennaLights) {
      const on = night > 0.3 && Math.floor(time * 1.2) % 2 === 0;
      if (on) this.antennaMat.color.setRGB(...lamps.warning);
      else this.antennaMat.color.setRGB(0.25, 0.02, 0.02);
    }
  }
}
