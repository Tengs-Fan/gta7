// Street furniture and landmarks as instanced meshes, with night lighting,
// live traffic signal bulbs and breakable props.

import * as THREE from 'three';
import { mooredBoat } from './boatModels';
import { paletteMaterial } from './shapeKit';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { smoothstep, type V3 } from '../core/math';
import { Rng } from '../core/rng';
import { SEABED_Y } from '../world/constants';
import { attractionOf } from '../world/attractions';
import { hashInts, rectContains, type Prop, type PropKind, type Rect } from '../world/layout';
import { FERRIS_HUB, FERRIS_LEG_X, FERRIS_LEG_Z, type StaticWorld } from '../world/staticWorld';
import { riseAt } from '../world/terrain';
import { adTexture, AD_COUNT, glowTexture, groundTexture, radialTexture, signalAtlas, signalGlowTexture, SIGNAL_TILE_RECTS } from './textures';
import { DARK_SIGNAL, hasOpposite, LIT, LIT_COLORS, quadLit, showKey, showScratch, signalQuads, signalShow, signalStyle, walkAxes, type QuadRole, type SignalShow } from './signalHeads';
import { spatialKey, STATIC_CHUNK_SIZE, StaticVisibility } from './spatial';
import { OCCLUDER_AXIS, OCCLUDER_FADE_EDGES, OCCLUDER_GLSL, OCCLUDER_LENS_FAR, OCCLUDER_SEGMENTS, occluderAxisPoints, occluderOpacityPath, type OccluderKind } from './occluderFade';
import { broadleafClusters, broadleafGeometry, broadleafSamples, broadleafTexture, PALM_BEND, PALM_CROWN, PALM_TOP, palmFrondsGeometry, palmTrunkGeometry, treeTrunkGeometry } from './foliage';
import {
  benchGeometry, binGeometry, bollardGeometry, drumGeometry, fenceGeometry, hydrantGeometry, jackGeometry, lampHeadGeometry, lampHousingGeometry, lampLensGeometry, lampShadowGeometry,
  lampPoleGeometry, lampTubeGeometry, lifeguardGeometry, loungerGeometry, mailboxGeometry, planterGeometry, posterGeometry, railGeometry, shelvingGeometry, shrubGeometry,
  signalGeometry, signalLayout, surfboardGeometry, toolChestGeometry, toolWallGeometry, towelGeometry, tyreRackGeometry, tyreStackGeometry, umbrellaGeometry,
  volleyballGeometry, wheelieBinGeometry, workbenchGeometry,
} from './furniture';
import { dressingItems, type DressingItem, type DressingKind } from './dressing';
import { WIND_GLSL, windAmplitude } from './wind';
import { SHADOW_LAYER } from './vehicleBatches';
import { CORN_H, cornGeometry, cornTexture, headstoneGeometry, HEADSTONE_SHAPES, ironFenceGeometry, pumpkinGeometry } from './attractionModels';
import { speakerGeometry } from './country/driveIn';
import { applesGeometry, baleTexture, COW_NECK, cowGeometry, cowTexture, farmFenceGeometry, propaneGeometry, scarecrowGeometry } from './country/farmModels';
import { roadsideAtlas, roadsideGeometry } from './country/roadside';
import { stopSignGeometry } from './country/stopSign';
import { pumpGeometry } from './country/town';

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

/** Shared envelopes for the actual smooth, irregular canopy geometry. */
function foliageParts(q: Prop) {
  return q.kind === 'tree' || q.kind === 'bush' ? broadleafClusters(q.kind) : [];
}

/** PropsView.standard's placement of a point given in a prop's frame: turned by rot about Y, scaled, at the prop. */
export function placed(q: Prop, x: number, y: number, z: number): [number, number, number] {
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

/** Actual foliage corners and densely sampled faces, placed in world space for camera clearance. */
export function foliagePoints(q: Prop): number[] {
  if (q.kind !== 'tree' && q.kind !== 'bush') return [];
  const points = broadleafSamples(q.kind);
  const out: number[] = [];
  for (let k = 0; k < points.length; k += 3) out.push(...placed(q, points[k]!, points[k + 1]!, points[k + 2]!));
  return out;
}

/**
 * Makes an instanced foliage material dissolve close to the camera: fragments within
 * FOLIAGE_FADE_FAR of it are thinned out by a 4x4 Bayer dither (all of them nearer than 1.2 m),
 * so a canopy the camera pushes into turns see-through instead of filling the screen. Opaque, so no
 * sorting and no extra draws; shadows come from the default depth material and are unaffected.
 */
export function fadeNearCamera(mat: THREE.Material, wind?: WindPatch): void {
  mat.userData.contactShadow = false; // The normal override cannot reproduce the near-camera dissolve.
  mat.onBeforeCompile = (shader) => {
    if (wind) windVertex(shader, wind);
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

/** The wind every foliage material shares (wind.ts), and where one material's foliage hangs from. */
export interface WindUniforms {
  uWindTime: { value: number };
  uWindAmp: { value: number };
  uWindDir: { value: THREE.Vector2 };
}

export interface WindPatch {
  shared: WindUniforms;
  /** Local point the foliage grows from and the reach (m) over which its sway builds up (w 0: none, full sway). */
  pivot: THREE.Vector4;
}

/**
 * Sways foliage vertices (leaf cards, palm fronds) by wind.ts's windOffset, in world space, before anything else reads
 * `transformed`. Uniforms only, so the weather and the time change no program. Shadows keep the unswayed shape.
 */
function windVertex(shader: THREE.WebGLProgramParametersWithUniforms, wind: WindPatch): void {
  Object.assign(shader.uniforms, wind.shared, { uWindPivot: { value: wind.pivot } });
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
uniform vec4 uWindPivot;
${WIND_GLSL}`)
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
{
  mat4 windFrame = modelMatrix;
  #ifdef USE_INSTANCING
  windFrame = modelMatrix * instanceMatrix;
  #endif
  vec3 windWorld = ( windFrame * vec4( transformed, 1.0 ) ).xyz;
  float windReach = uWindPivot.w > 0.0 ? clamp( distance( transformed, uWindPivot.xyz ) / uWindPivot.w, 0.0, 1.0 ) : 1.0;
  transformed += inverse( mat3( windFrame ) ) * windOffset( windWorld, windWorld.y - windFrame[ 3 ].y, windReach );
}`,
    );
}

/** The camera and the subject it frames, and the fade edges (OCCLUDER_FADE_EDGES; all negative: no dissolve). */
interface OccluderUniforms {
  uOccCam: { value: THREE.Vector3 };
  uOccSubject: { value: THREE.Vector3 };
  uOccFade: { value: THREE.Vector4 };
}

const OCCLUDER_OFF = [-2, -1, -2, -1] as const;

/**
 * Makes an instanced pole or trunk material dissolve where it stands between the camera and what it frames, or right
 * at the lens (occluderFade.ts): each instance's axis, `axis` in its own frame, is tested once per vertex against the
 * shared camera and subject uniforms, and its fragments are thinned out by a 4x4 Bayer dither, as fadeNearCamera does
 * for foliage. Opaque, so no sorting; uniforms only, so switching it on and off compiles nothing. Shadows come from
 * the default depth material and are unaffected; PropsView keeps a dissolving batch out of the contact-shadow pass.
 */
function dissolveOccluder(mat: THREE.Material, axis: { readonly from: number; readonly to: number }, shared: OccluderUniforms, bend = 0): void {
  const span = { value: new THREE.Vector2(axis.from, axis.to) };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, { uOccSpan: span, uOccBend: { value: bend } });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uOccCam;
uniform vec3 uOccSubject;
uniform vec4 uOccFade;
uniform vec2 uOccSpan;
uniform float uOccBend;
varying float vOccKeep;
${OCCLUDER_GLSL}`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
{
  mat4 occFrame = modelMatrix;
  #ifdef USE_INSTANCING
  occFrame = modelMatrix * instanceMatrix;
  #endif
  // The axis in its own frame: straight up, or leaning uOccBend * y^2 along +x (a curved palm), in segments.
  int occN = uOccBend == 0.0 ? 1 : ${OCCLUDER_SEGMENTS};
  vec3 occA = ( occFrame * vec4( uOccBend * uOccSpan.x * uOccSpan.x, uOccSpan.x, 0.0, 1.0 ) ).xyz;
  float occLine = 1e9;
  float occLens = 1e9;
  for ( int occI = 1; occI <= ${OCCLUDER_SEGMENTS}; occI ++ ) {
    if ( occI > occN ) break;
    float occY = mix( uOccSpan.x, uOccSpan.y, float( occI ) / float( occN ) );
    vec3 occB = ( occFrame * vec4( uOccBend * occY * occY, occY, 0.0, 1.0 ) ).xyz;
    occLine = min( occLine, occSegSeg( uOccCam, uOccSubject, occA, occB ) );
    occLens = min( occLens, occPointSeg( uOccCam, occA, occB ) );
    occA = occB;
  }
  vOccKeep = min( smoothstep( uOccFade.x, uOccFade.y, occLine ), smoothstep( uOccFade.z, uOccFade.w, occLens ) );
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vOccKeep;
float occBayer4( vec2 frag ) {
  const float m[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
  ivec2 p = ivec2( mod( floor( frag ), 4.0 ) );
  return ( m[ p.x + p.y * 4 ] + 0.5 ) / 16.0;
}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
if ( vOccKeep < 1.0 && occBayer4( gl_FragCoord.xy ) >= vOccKeep ) discard;`,
      );
  };
  mat.customProgramCacheKey = () => 'gta7-occluder';
}

/**
 * Collapses the spare parts of a model (aSpare 1 on their vertices, furniture.ts ModelBuilder.spare) on the instances
 * that have no use for them (aSpareOff 1) to a point at the instance's foot, so they are not drawn. Patched after the
 * material's own patch, and keyed by `key`, as the program is no longer the other dissolving materials'.
 */
function collapseSpares(mat: THREE.Material, key: string): void {
  const patched = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    patched(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSpare;\nattribute float aSpareOff;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nif ( aSpare * aSpareOff > 0.5 ) transformed = vec3( 0.0 );');
  };
  mat.customProgramCacheKey = () => key;
}

/**
 * Draws the signals' lit parts (signalHeads.ts) from one instanced unit quad. Each instance carries its signal's own
 * matrix, so the quads stand, fall and dissolve with their pole (dissolveOccluder, patched first); in that frame, its
 * place and turn (aQuad) and size (aSize); and what it shows (aLit: an atlas tile and a palette entry), so a light that
 * changes rewrites two floats. The atlas's red is the LEDs lit in the palette colour, its green the faint grid of all.
 */
function litQuads(mat: THREE.MeshBasicMaterial, colors: readonly THREE.Color[], dots: { value: number }): void {
  const occluder = mat.onBeforeCompile;
  const tiles = SIGNAL_TILE_RECTS.map((r) => new THREE.Vector4(...r));
  mat.onBeforeCompile = (shader, renderer) => {
    occluder(shader, renderer);
    Object.assign(shader.uniforms, { uLitTiles: { value: tiles }, uLitColors: { value: colors }, uLitDots: dots });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aQuad;
attribute vec2 aSize;
attribute vec2 aLit;
uniform vec4 uLitTiles[ ${tiles.length} ];
uniform vec3 uLitColors[ ${colors.length} ];
varying vec3 vLit;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
{
  vec4 tile = uLitTiles[ int( aLit.x + 0.5 ) ];
  vMapUv = tile.xy + uv * tile.zw;
  vLit = uLitColors[ int( aLit.y + 0.5 ) ];
}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  // The unit quad sized, turned about y (0 faces +z) and set in its place in the signal's frame.
  vec2 q = position.xy * aSize;
  transformed = vec3( q.x * cos( aQuad.w ), q.y, - q.x * sin( aQuad.w ) ) + aQuad.xyz;
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uLitDots;\nvarying vec3 vLit;')
      .replace(
        '#include <map_fragment>',
        `vec4 ledTexel = texture2D( map, vMapUv );
diffuseColor.rgb = vLit * ledTexel.r + uLitDots * ledTexel.g;`,
      );
  };
  mat.customProgramCacheKey = () => 'gta7-signal-lit';
}

/**
 * The signals' lit quads' palette (update sets the unlit lenses'): every lit part on every tier just where ACES keeps
 * its hue (brighter, it pales towards white: a red light must read red), far under the bloom threshold, so the
 * countdowns' digits stay sharp; at night a halo glows round a lit lens.
 */
function litPalette(): THREE.Color[] {
  const c = Array.from({ length: LIT_COLORS }, () => new THREE.Color(0, 0, 0));
  c[LIT.red]!.setRGB(1.25, 0.01, 0.005);
  c[LIT.yellow]!.setRGB(1.15, 0.45, 0);
  c[LIT.green]!.setRGB(0, 0.78, 0.3);
  c[LIT.countRed]!.setRGB(1.2, 0.03, 0.01);
  c[LIT.countGreen]!.setRGB(0, 0.75, 0.28);
  c[LIT.walk]!.setRGB(0.1, 0.8, 0.42);
  c[LIT.hand]!.setRGB(1.2, 0.22, 0);
  return c;
}

/** A pole or trunk the camera may dissolve: its axis now (world space) and whether it is gone (a knocked-down lamp). */
interface Occluder {
  index: number;
  kind: OccluderKind;
  base: V3;
  top: V3;
  /** The axis as a polyline from base to top (two points unless it bends). */
  path: V3[];
  hidden: boolean;
  fallen: boolean;
}

/** A palm trunk's built-in curve as the occluder shader takes it: the lean is PALM_BEND x (y / PALM_TOP)^2. */
const PALM_OCC_BEND = PALM_BEND / (PALM_TOP * PALM_TOP);

/** How far (m) a palm's trunk top stands off its foot, by a hash of its position: 0.45 to 1.4 m. */
export function palmLean(p: Prop): number {
  let h = Math.imul(Math.round(p.x * 10) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(p.z * 10) | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return 0.45 + 0.95 * ((h >>> 0) / 4294967296);
}

/** A palm's instance matrix: its turn and scale, and a shear that sets the lean of its top to palmLean (see palmCurve). */
export function palmMatrix(p: Prop, m: THREE.Matrix4): THREE.Matrix4 {
  const a = (palmLean(p) / p.scale - PALM_BEND) / PALM_TOP;
  const shear = new THREE.Matrix4().set(1, a, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  m.compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot), new THREE.Vector3(p.scale, p.scale, p.scale));
  return m.multiply(shear);
}

/** The centre line of a palm's trunk in world space, OCCLUDER_SEGMENTS straight pieces from its foot to its crown. */
export function palmAxis(p: Prop): V3[] {
  const m = palmMatrix(p, new THREE.Matrix4());
  const v = new THREE.Vector3();
  return occluderAxisPoints(OCCLUDER_AXIS.palm, PALM_OCC_BEND).map(([x, y, z]) => {
    v.set(x, y, z).applyMatrix4(m);
    return { x: v.x, y: v.y, z: v.z };
  });
}

/** Bucket size (m) of PropsView's occluder lookup. */
const OCC_CELL = 16;

const BEAM_LENGTH = 90;
const GLOW_COLOR = new THREE.Color(0xffe6b0);

type Rgb = readonly [number, number, number];

/**
 * The aircraft warning lights, lit. ACES tone-maps a lamp far above 1 to a near-white core, so with bloom its luminance
 * stays above the bloom threshold (2.6) and the halo round it carries the colour (the red leans a little orange to get
 * there). Without bloom (Low, or no half-float target) only that core is drawn, so it stays where ACES keeps the hue.
 * The signals' lenses keep a saturated core on every tier instead (litPalette): a lens 30 cm across is many pixels of
 * that near-white core, and a red light must read red.
 */
const WARNING: Readonly<Record<'glow' | 'flat', Rgb>> = { glow: [9.5, 1.1, 0.22], flat: [1.1, 0.02, 0.015] };
/**
 * The Ferris wheel's lights: 64 bulbs round the rim, alternately on its front and back tube, standing
 * proud of the tube (centred FERRIS_BULB_Z out, the tubes' centre lines being 1.6 out with a 0.3 m
 * radius) so that a viewer sees the whole bulb rather than a sliver. Each is a saturated core (ACES
 * keeps its hue, as on Low) with its own additive halo FERRIS_HALO m across (never under
 * HALO_MIN_PX pixels), so the colour no longer hangs on the bloom pass catching a 2-3 px cap.
 */
const FERRIS_R = 22;
const FERRIS_LIGHTS = 64;
const FERRIS_BULB_Z = 1.95;
const FERRIS_BULB_R = 0.26;
const FERRIS_HALO = 1.5;
const HALO_MIN_PX = 3;
/** The halo's strength against its core: under the bloom threshold, so it does not flicker in and out. */
const FERRIS_HALO_I = 0.9;
/**
 * A street lamp's glow: its own additive halo LAMP_HALO m across (never under HALO_MIN_PX pixels) just under the bulb, at
 * full night LAMP_HALO_COLOR at its centre, on every tier, as the Ferris wheel's lights have. The bulb is a 4 cm plate seen
 * edge-on, 1-2 px tall at 30 m, so a glow that hung on the bloom pass catching it switched on and off as the camera moved.
 * The bulb (see update) and its halo together stay under the bloom threshold (2.6), so bloom no longer toggles on a lamp.
 */
const LAMP_HALO = 2.2;
/**
 * A street lamp's luminaire in the prop's frame (before its scale): the underside of its lens `y` m up, `reach` m out
 * along the arm (local +z). The halo, the light pool and StreetLighting's spot all hang off this point.
 */
export const LAMP_HEAD = { y: 6.3, reach: 1.55 } as const;
/**
 * A street lamp's light, from LAMP_HEAD: its colour and the cone it throws down, as High's real lamp spots draw it on
 * the cars and facades near the camera (StreetLighting) and as every tier's light pool lays it on the ground.
 */
export const LAMP_LIGHT = { color: 0xffd09a, intensity: 55, angle: 1.12, penumbra: 0.75 } as const;
/** The light pool under a lamp: LAMP_POOL m across, at full night LAMP_POOL_GAIN of LAMP_LIGHT's colour at its centre. */
export const LAMP_POOL = 18;
const LAMP_POOL_GAIN = 0.21;

/**
 * The lamp's light on flat ground `r` m from straight under its head, 1 there: from a point LAMP_HEAD.y up, falling as the
 * cube of the cosine of the angle off the vertical, inside LAMP_LIGHT's cone and its soft edge (three's spot light). So
 * the pool is broad and flat-topped, 0.71 at 3 m and 0.22 at 6 m: a lamp over 6 m up lights no hot spot under itself.
 */
export function lampPoolShape(r: number): number {
  const c = LAMP_HEAD.y / Math.hypot(LAMP_HEAD.y, r);
  return c ** 3 * THREE.MathUtils.smoothstep(c, Math.cos(LAMP_LIGHT.angle), Math.cos(LAMP_LIGHT.angle * (1 - LAMP_LIGHT.penumbra)));
}

/** The light pool's decal at `u`, the distance from its centre over its half size: lampPoolShape, faded out over its last quarter. */
export function lampPoolDecal(u: number): number {
  return lampPoolShape((u * LAMP_POOL) / 2) * (1 - THREE.MathUtils.smoothstep(u, 0.75, 1));
}

const LAMP_HALO_Y = LAMP_HEAD.y - 0.08;
const LAMP_HALO_COLOR = new THREE.Color(0.65, 0.52, 0.33);
/**
 * A lit signal lens's glow at night: its own additive halo SIGNAL_HALO m across (never under HALO_MIN_PX pixels), as a
 * street lamp's, in the lens's colour at full night (red, yellow, green), but a ring round the lens (the atlas's glow tile)
 * so it leaves the lens's own colour saturated, both under the bloom threshold; seen only from in front of the lens,
 * so a cross street's lights glow at their own traffic, not at you.
 */
const SIGNAL_HALO = 1.1;
const SIGNAL_HALO_COLORS: readonly Rgb[] = [[0.85, 0.05, 0.02], [0.8, 0.4, 0.02], [0.03, 0.7, 0.35]];
const NO_HALO: Rgb = [0, 0, 0];

/**
 * More update ranges than this on a buffer are worth less than all of it: the whole buffer as one range, which the
 * renderer uploads in one call (the ranges merge, so later ones still add up to it until it is uploaded).
 */
export const SIGNAL_UPLOAD_RANGES = 32;

/** Sends `attr` to the GPU at the next render: the ranges added to it, or all of it when there are too many. */
function uploadRanges(attr: THREE.BufferAttribute): void {
  if (attr.updateRanges.length > SIGNAL_UPLOAD_RANGES) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, attr.array.length);
  }
  attr.needsUpdate = true;
}

/** A halo is depth-tested as if this much (m) nearer the camera, so the lamp it glows round (its head, a tube) cannot cut into it. */
const HALO_PULL = 0.6;

/**
 * A halo's glow without a texture (none to upload when the lights come on at night): glowTexture's profile, 1 at the
 * centre, 0.45 at 0.35 of the radius and nothing at its edge.
 */
const HALO_GLOW = /* glsl */ `
float haloU = length( gl_PointCoord - 0.5 ) * 2.0;
diffuseColor.a *= haloU < 0.35 ? 1.0 - haloU * ( 0.55 / 0.35 ) : max( 0.0, 0.45 * ( 1.0 - haloU ) / 0.65 );`;

/**
 * The additive glow round each point of a Points, coloured by its vertex colours, `size` m across but never under
 * HALO_MIN_PX pixels: `map`'s, or with none HALO_GLOW. A signal lens's halo takes `occluder`: it shows only to a camera
 * in front of its lens (its `aFacing` direction per point), fading out from 60 degrees off its axis to a little past
 * 90, and it dissolves with its signal's pole (`aFoot`, the signal's foot per point, the same axis and uniforms as the
 * pole's: dissolveOccluder).
 */
function haloMaterial(map: THREE.Texture | null, size: number, occluder: OccluderUniforms | null = null): THREE.PointsMaterial {
  const mat = new THREE.PointsMaterial({ size, map, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const span = { value: new THREE.Vector2(OCCLUDER_AXIS.signal.from, OCCLUDER_AXIS.signal.to) };
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_vertex>',
      `#include <fog_vertex>
gl_PointSize = max( gl_PointSize, ${HALO_MIN_PX.toFixed(1)} );
gl_Position = projectionMatrix * vec4( mvPosition.xyz * max( 0.0, 1.0 - ${HALO_PULL.toFixed(2)} / length( mvPosition.xyz ) ), 1.0 );`,
    );
    if (!map) shader.fragmentShader = shader.fragmentShader.replace('#include <map_particle_fragment>', HALO_GLOW);
    if (occluder) {
      Object.assign(shader.uniforms, occluder, { uOccSpan: span });
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec3 aFacing;
attribute vec3 aFoot;
uniform vec3 uOccCam;
uniform vec3 uOccSubject;
uniform vec4 uOccFade;
uniform vec2 uOccSpan;
${OCCLUDER_GLSL}`,
        )
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
vColor *= smoothstep( -0.15, 0.5, dot( aFacing, normalize( cameraPosition - ( modelMatrix * vec4( position, 1.0 ) ).xyz ) ) );
{
  vec3 occA = aFoot + vec3( 0.0, uOccSpan.x, 0.0 );
  vec3 occB = aFoot + vec3( 0.0, uOccSpan.y, 0.0 );
  vColor *= min( smoothstep( uOccFade.x, uOccFade.y, occSegSeg( uOccCam, uOccSubject, occA, occB ) ), smoothstep( uOccFade.z, uOccFade.w, occPointSeg( uOccCam, occA, occB ) ) );
}`,
        );
    }
  };
  mat.customProgramCacheKey = () => (occluder ? 'gta7-halo-facing' : 'gta7-halo');
  return mat;
}

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

/** The garage posters: two designs side by side (a tyre brand and a hot-rod pin-up), drawn once. */
function posterTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (ctx) {
    const sheet = (x: number, bg: string, fg: string, title: string, sub: string) => {
      ctx.fillStyle = '#ece6d6';
      ctx.fillRect(x, 0, 256, 256);
      ctx.fillStyle = bg;
      ctx.fillRect(x + 14, 14, 228, 228);
      ctx.fillStyle = fg;
      ctx.font = '700 46px Anton, Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(title, x + 128, 70, 210);
      ctx.font = '600 22px Inter, Arial, sans-serif';
      ctx.fillText(sub, x + 128, 226, 210);
      ctx.beginPath();
      ctx.arc(x + 128, 140, 52, 0, Math.PI * 2);
      ctx.lineWidth = 22;
      ctx.strokeStyle = fg;
      ctx.stroke();
    };
    sheet(0, '#b8241c', '#f4d03f', 'AZURA', 'TYRES & RUBBER');
    sheet(256, '#1d3557', '#f1faee', 'V8 CLUB', 'SAN AZURA 1987');
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class PropsView {
  readonly group = new THREE.Group();
  /** The batches holding any of the city's props, and those of Las Lomas County's alone (from country.firstProp on). */
  private readonly visibility = new StaticVisibility();
  private readonly countyVisibility = new StaticVisibility();
  private readonly refs = new Map<number, InstanceRef[]>();
  /** Shadow-only stand-ins (SHADOW_LAYER) by prop index, moved with their prop by breakProp and restoreAll. */
  private readonly shadowRefs = new Map<number, InstanceRef[]>();
  private readonly bulbMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
  private readonly poolMat: THREE.MeshBasicMaterial;
  /** Every signal's lit parts citywide, one quad each (litQuads), and by signal its first quad, their roles and what they show. */
  private signalLit: THREE.InstancedMesh | null = null;
  private readonly signalSlots: Array<{ first: number; roles: readonly QuadRole[]; blank: readonly boolean[]; halo: number; lenses: number; pole: THREE.Object3D; shown: boolean }> = [];
  /** The lit quads' sizes (aSize), a blank one 0: what a signal's quads are drawn at while its pole's batch is (cull). */
  private signalSizes: Float32Array = new Float32Array(0);
  /** A halo round every signal lens (SIGNAL_HALO), from each signal's slot `halo` on, three to a head; dark unless lit. */
  private signalHalos: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  private signalKeys: Float64Array = new Float64Array(0);
  /** The show of the signal being looked at (showOf). */
  private readonly scratch = showScratch();
  /** The lit quads' palette by LIT entry and the faint grid of their unlit LEDs. */
  private readonly litColors = litPalette();
  private readonly litDots = { value: 0 };
  private signalProps: Prop[] = [];
  private signalPropIndex: number[] = [];
  private readonly brokenSignals = new Set<number>();
  private lampHalos: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  /** The vertex of lampHalos for each lamp's prop index. */
  private readonly lampHaloIndex = new Map<number, number>();
  private ferris: { wheel: THREE.Group; gondolas: THREE.InstancedMesh; lights: THREE.InstancedMesh; halos: THREE.Points; x: number; y: number; z: number; rot: number } | null = null;
  private lighthouseBeam: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private lighthouseGlow: THREE.Sprite | null = null;
  private antennaLights: THREE.InstancedMesh | null = null;
  private readonly antennaMat = new THREE.MeshBasicMaterial({ color: 0x220000 });
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpC = new THREE.Color();
  /** Whether a bloom pass draws halos round bright lights, which picks the warning lights' colour (see WARNING). */
  private glow = true;
  /** Shared by every pole and trunk material (dissolveOccluder). */
  private readonly occUniforms: OccluderUniforms = {
    uOccCam: { value: new THREE.Vector3() },
    uOccSubject: { value: new THREE.Vector3() },
    uOccFade: { value: new THREE.Vector4(...OCCLUDER_OFF) },
  };
  private readonly occluders: Occluder[] = [];
  private readonly occByProp = new Map<number, Occluder>();
  /** Standing occluders by OCC_CELL cell of their foot; fallen ones (a knocked-over signal) are looked at separately. */
  private readonly occCells = new Map<string, Occluder[]>();
  /** Batches holding an occluder that is dissolving now: kept out of the contact-shadow pass (see setOccluderView). */
  private readonly occFlagged = new Set<THREE.Object3D>();
  private readonly occFallen = new Set<Occluder>();
  /** Shared by every foliage material (windVertex; the county's crops too, render/country/fields.ts); setWind and setWindEnabled drive it. */
  readonly windUniforms: WindUniforms = { uWindTime: { value: 0 }, uWindAmp: { value: windAmplitude(0) }, uWindDir: { value: new THREE.Vector2(1, 0) } };
  private windOn = true;
  private windSpeed = 0;
  /** The dressing's instanced meshes by kind (beach, yards, decks, garages). */
  readonly dressing = new Map<DressingKind, THREE.InstancedMesh[]>();

  /** `chunk`: the cell size instances are batched in (one draw per prop shape and cell). */
  constructor(private readonly world: StaticWorld, private readonly chunk = STATIC_CHUNK_SIZE) {
    this.group.name = 'props';
    this.poolMat = new THREE.MeshBasicMaterial({ map: radialTexture(lampPoolDecal), color: LAMP_LIGHT.color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
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

    this.buildTrees(get('tree'), get('bush'), get('cypress'), get('orchardTree'));
    this.buildPalms(get('palm'));
    this.buildLamps(get('lamp'));
    this.buildSignals(get('signal'));
    this.buildSimple(get('hydrant'), hydrantGeometry(), new THREE.MeshStandardMaterial({ color: 0xc0281c, vertexColors: true, roughness: 0.45, metalness: 0.1 }));
    this.buildSimple(get('bench'), benchGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.78, metalness: 0.15 }));
    this.buildSimple(get('bin'), binGeometry(), new THREE.MeshStandardMaterial({ color: 0x1e4d2b, vertexColors: true, roughness: 0.6, metalness: 0.3 }));
    this.buildContainers(get('container'));
    this.buildCorn(get('corn'));
    this.makeInstanced(pumpkinGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.55 }), get('pumpkin'), PropsView.standard, {
      color: (p, c) => c.setHSL(0.05 + (p.rot % 1) * 0.02, 0.95, 0.3 + (p.scale - 1) * 0.1),
    });
    this.buildHeadstones(get('headstone'));
    this.buildFarmProps(get);
    this.buildRoadside(get('roadside'));
    // Las Lomas County's two stop signs, the drive-in's speaker posts and its apple trees (buildTrees) are few, each in
    // one place: one batch each, not one per cell, as the farms' props are.
    this.makeInstanced(stopSignGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0.2 }), get('stopSign'), PropsView.standard, { chunked: true });
    for (const i of get('fountain')) this.buildFountain(world.layout.props[i]!);
    for (const i of get('crane')) this.buildCrane(world.layout.props[i]!);
    for (const i of get('lighthouse')) this.buildLighthouse(world.layout.props[i]!);
    for (const i of get('ferris')) this.buildFerris(world.layout.props[i]!);
    for (const i of get('boat')) this.buildBoat(world.layout.props[i]!);
    // Las Lomas County's billboards carry its own ads (render/country/town.ts).
    get('billboard').filter((i) => world.layout.props[i]!.x >= world.layout.bounds.landMinX).forEach((i, k) => this.buildBillboard(world.layout.props[i]!, k));
    this.makeInstanced(pumpGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0.2 }), get('pump'), PropsView.standard);
    this.makeInstanced(speakerGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.3 }), get('speaker'), PropsView.standard, { chunked: true });
    this.buildRoofProps();
    this.buildDressing(dressingItems(world));
    world.layout.props.forEach((p, i) => {
      if (p.kind !== 'lamp' && p.kind !== 'signal' && p.kind !== 'tree' && p.kind !== 'palm') return;
      const o: Occluder = { index: i, kind: p.kind, base: { x: 0, y: 0, z: 0 }, top: { x: 0, y: 0, z: 0 }, path: [], hidden: false, fallen: false };
      this.standUp(o);
      this.occluders.push(o);
      this.occByProp.set(i, o);
      const key = `${Math.floor(p.x / OCC_CELL)},${Math.floor(p.z / OCC_CELL)}`;
      let cell = this.occCells.get(key);
      if (!cell) this.occCells.set(key, cell = []);
      cell.push(o);
    });
    // Also cover unique signs/landmarks, which are not created by makeInstanced.
    const first = world.layout.country.firstProp;
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const county = (o.userData.propIndices as number[] | undefined)?.every((i) => i >= first) ?? false;
      (county ? this.countyVisibility : this.visibility).add(o, 8);
    });
  }

  /**
   * Each frame: hides the batches farther than `city` m from (x, z), and those of Las Lomas County's props alone farther
   * than `county` m.
   */
  cull(x: number, z: number, city: number, county: number): void {
    this.visibility.update(x, z, city);
    this.countyVisibility.update(x, z, county);
    this.cullSignalQuads();
  }

  /**
   * The signals' lit quads are one citywide batch, so culling cannot hide them with their poles: the quads of a signal
   * whose pole's batch is hidden are collapsed (size 0), and restored when it shows again.
   */
  private cullSignalQuads(): void {
    const quads = this.signalLit;
    if (!quads) return;
    const size = quads.geometry.getAttribute('aSize') as THREE.InstancedBufferAttribute;
    let changed = false;
    for (const slot of this.signalSlots) {
      if (slot.pole.visible === slot.shown) continue;
      slot.shown = slot.pole.visible;
      const from = slot.first * 2;
      const to = from + slot.roles.length * 2;
      if (slot.shown) (size.array as Float32Array).set(this.signalSizes.subarray(from, to), from);
      else (size.array as Float32Array).fill(0, from, to);
      changed = true;
    }
    if (changed) size.needsUpdate = true;
  }

  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, props: number[], matrixFor: (p: Prop, m: THREE.Matrix4) => void, opts: { shadow?: boolean; color?: (p: Prop, c: THREE.Color) => void; track?: boolean; chunked?: boolean; depth?: THREE.Material } = {}): THREE.InstancedMesh | null {
    if (props.length === 0) return null;
    if (!opts.chunked) {
      const buckets = new Map<string, number[]>();
      props.forEach((pi, i) => {
        const p = this.world.layout.props[pi]!;
        const key = spatialKey(p.x, p.z, this.chunk);
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, bucket = []);
        bucket.push(i);
      });
      if (buckets.size > 1) {
        let first: THREE.InstancedMesh | null = null;
        const attributes = Object.entries(geo.attributes).filter(([, a]) => a instanceof THREE.InstancedBufferAttribute);
        for (const slots of buckets.values()) {
          // Lamp light pools carry one clip rectangle per instance. It must follow the prop
          // into its new cell, just like the break/restore references built below.
          const part = attributes.length ? geo.clone() : geo;
          for (const [name, attr] of attributes) {
            const values = new Float32Array(slots.length * attr.itemSize);
            slots.forEach((old, i) => {
              for (let k = 0; k < attr.itemSize; k++) values[i * attr.itemSize + k] = attr.getComponent(old, k);
            });
            part.setAttribute(name, new THREE.InstancedBufferAttribute(values, attr.itemSize));
          }
          const mesh = this.makeInstanced(part, mat, slots.map((i) => props[i]!), matrixFor, { ...opts, chunked: true });
          first ??= mesh;
        }
        if (attributes.length) geo.dispose();
        return first;
      }
    }
    const mesh = new THREE.InstancedMesh(geo, mat, props.length);
    mesh.userData.propIndices = props;
    mesh.castShadow = opts.shadow ?? true;
    mesh.receiveShadow = true;
    if (opts.depth) mesh.customDepthMaterial = opts.depth;
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

  /** Uploads the instances of meshes whose props were moved, and bounds each once (the signals' lit quads span the city). */
  private static moved(meshes: ReadonlySet<THREE.InstancedMesh>): void {
    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /**
   * A low-poly shadow caster for detailed props, one instanced mesh per cell drawn only into the shadow map
   * (SHADOW_LAYER; the renderer's shadow pass enables it). `mat` is never drawn by the camera; reusing the prop's own
   * material keeps the program set unchanged.
   */
  private shadowProxies(geo: THREE.BufferGeometry, mat: THREE.Material, props: number[], matrixFor: (p: Prop, m: THREE.Matrix4) => void): void {
    const buckets = new Map<string, number[]>();
    for (const pi of props) {
      const p = this.world.layout.props[pi]!;
      const key = spatialKey(p.x, p.z, this.chunk);
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, bucket = []);
      bucket.push(pi);
    }
    const m = new THREE.Matrix4();
    for (const cell of buckets.values()) {
      const mesh = new THREE.InstancedMesh(geo, mat, cell.length);
      mesh.name = geo.name;
      mesh.layers.set(SHADOW_LAYER);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.userData.contactShadow = false;
      cell.forEach((pi, k) => {
        matrixFor(this.world.layout.props[pi]!, m);
        mesh.setMatrixAt(k, m);
        let l = this.shadowRefs.get(pi);
        if (!l) this.shadowRefs.set(pi, l = []);
        l.push({ mesh, index: k, base: m.clone() });
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
  }

  private buildSimple(props: number[], geo: THREE.BufferGeometry, mat: THREE.Material): void {
    this.makeInstanced(geo, mat, props, PropsView.standard);
  }

  private buildTrees(trees: number[], bushes: number[], cypresses: number[], orchard: number[]): void {
    const rng = new Rng(77);
    const trunk = new THREE.MeshStandardMaterial({ color: 0x725440, vertexColors: true, roughness: 0.96 });
    dissolveOccluder(trunk, OCCLUDER_AXIS.tree, this.occUniforms);
    this.makeInstanced(treeTrunkGeometry(), trunk, trees, PropsView.standard);
    this.makeInstanced(treeTrunkGeometry(), trunk, cypresses, (p, m) => {
      PropsView.standard(p, m);
      m.multiply(this.tmpM.makeScale(0.6, 0.55, 0.6));
    });
    // Leaf cards: alpha-tested (never sorted), the atlas's own greens with a per-tree tint, swaying in the wind.
    const leafMaterial = (name: string): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, map: broadleafTexture(), alphaTest: 0.5, roughness: 0.86 });
      m.name = name;
      fadeNearCamera(m, { shared: this.windUniforms, pivot: new THREE.Vector4(0, 0, 0, 0) });
      m.customProgramCacheKey = () => 'gta7-foliage-leaves';
      return m;
    };
    const tint = new THREE.Color();
    const canopy = broadleafGeometry('tree');
    const canopyMat = leafMaterial('broadleaf-canopy');
    this.makeInstanced(canopy, canopyMat, trees, PropsView.standard, {
      color: (_p, c) => c.setRGB(1, 1, 1).lerp(tint.setHSL(0.24 + rng.range(-0.04, 0.04), rng.range(0.34, 0.52), rng.range(0.42, 0.55)), 0.45),
    });
    const shrub = broadleafGeometry('bush');
    const shrubMat = leafMaterial('broadleaf-shrub');
    this.makeInstanced(shrub, shrubMat, bushes, PropsView.standard, {
      color: (_p, c) => c.setRGB(1, 1, 1).lerp(tint.setHSL(0.27 + rng.range(-0.03, 0.03), 0.43, rng.range(0.4, 0.5)), 0.5),
      shadow: false,
    });
    // Cypresses: the trees' canopy drawn tall and narrow, from about a metre up to nine, dark.
    this.makeInstanced(canopy, canopyMat, cypresses, (p, m) => {
      PropsView.standard(p, m);
      m.multiply(this.tmpM.makeScale(0.42, 2.4, 0.42)).multiply(this.tmpM.makeTranslation(0, -2.6, 0));
    }, {
      color: (_p, c) => c.setRGB(1, 1, 1).lerp(tint.setHSL(0.31 + rng.range(-0.02, 0.02), 0.38, rng.range(0.2, 0.26)), 0.75),
    });
    // Las Lomas County's apple trees: the trees' trunk, short, under the shrubs' leaves grown into a round crown, apples on
    // it. Pippin Hollow's rows alone: one batch each, not one per cell.
    const apple = (p: Prop, m: THREE.Matrix4) => PropsView.standard(p, m);
    this.makeInstanced(treeTrunkGeometry(), trunk, orchard, (p, m) => {
      apple(p, m);
      m.multiply(this.tmpM.makeScale(0.5, 0.42, 0.5));
    }, { chunked: true });
    this.makeInstanced(shrub, shrubMat, orchard, (p, m) => {
      apple(p, m);
      m.multiply(this.tmpM.makeTranslation(0, 1.55, 0)).multiply(this.tmpM.makeScale(1.85, 2.1, 1.85));
    }, {
      color: (_p, c) => c.setRGB(1, 1, 1).lerp(tint.setHSL(0.26 + rng.range(-0.03, 0.03), 0.5, rng.range(0.36, 0.44)), 0.5),
      chunked: true,
    });
    this.makeInstanced(applesGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.45 }), orchard, apple, { shadow: false, track: false, chunked: true });
  }

  /**
   * Las Lomas County's farm props (world/country/farms.ts; the silos, bins and the windpump are the farms' own drawing,
   * render/country/farms.ts): fences, the propane tank, the scarecrows and the bale stacks, and the cows, which nod
   * as they graze (their heads turned about the neck by the foliage's clock). Few and small, spread over the county's
   * four farms: one batch each, not one per cell.
   */
  private buildFarmProps(get: (k: PropKind) => number[]): void {
    const painted = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8 });
    const one = { chunked: true } as const;
    this.makeInstanced(farmFenceGeometry(), painted, get('fence'), PropsView.standard, one);
    this.makeInstanced(propaneGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0.2 }), get('propane'), PropsView.standard, one);
    this.makeInstanced(scarecrowGeometry(), painted, get('scarecrow'), PropsView.standard, one);
    const bale = new THREE.MeshStandardMaterial({ map: baleTexture(), roughness: 0.95 });
    this.makeInstanced(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), bale, get('bale'), (p, m) => m.compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion(), new THREE.Vector3(p.w, p.h, p.d)), one);
    const hide = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, map: cowTexture(), roughness: 0.85 });
    const time = this.windUniforms.uWindTime;
    hide.onBeforeCompile = (shader) => {
      shader.uniforms.uCowTime = time;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uCowTime;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  float ph = 0.0;
  #ifdef USE_INSTANCING
  ph = instanceMatrix[ 3 ].x * 0.37 + instanceMatrix[ 3 ].z * 0.61;
  #endif
  // Head down to graze for a while, up to chew, down again; only what is forward of the neck turns.
  float graze = smoothstep( -0.2, 0.6, sin( uCowTime * 0.23 + ph ) ) * 0.8 + 0.08 * sin( uCowTime * 2.1 + ph );
  float a = graze * smoothstep( ${COW_NECK.z.toFixed(2)} - 0.1, ${COW_NECK.z.toFixed(2)} + 0.1, position.z );
  vec3 q = transformed - vec3( 0.0, ${COW_NECK.y.toFixed(2)}, ${COW_NECK.z.toFixed(2)} );
  transformed = vec3( q.x, q.y * cos( a ) - q.z * sin( a ), q.y * sin( a ) + q.z * cos( a ) ) + vec3( 0.0, ${COW_NECK.y.toFixed(2)}, ${COW_NECK.z.toFixed(2)} );
}`,
      );
    };
    hide.customProgramCacheKey = () => 'gta7-cow';
    const coats = [0xffffff, 0xffffff, 0xb07a48, 0x2a2624];
    this.makeInstanced(cowGeometry(), hide, get('cow'), PropsView.standard, { ...one, color: (p, c) => c.setHex(coats[p.color]!) });
  }

  /**
   * Las Lomas County's roadside furniture (world/country/oddities.ts): its mailboxes and hand-painted signs, every make of them
   * one batch (render/country/roadside.ts), each instance naming its own shape in `aPick`: the vertices of every other shape
   * are sent off the screen. They cast no shadow, which would be every shape's at every instance. A car knocks one over.
   */
  private buildRoadside(items: number[]): void {
    const { texture, blank, bands } = roadsideAtlas();
    const geo = roadsideGeometry(blank, bands);
    geo.setAttribute('aPick', new THREE.InstancedBufferAttribute(Float32Array.from(items, (pi) => this.world.layout.props[pi]!.color), 1));
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, map: texture, roughness: 0.85 });
    mat.name = 'roadside';
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aShape;\nattribute float aPick;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nif ( aShape != aPick ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );');
    };
    mat.customProgramCacheKey = () => 'gta7-roadside';
    this.makeInstanced(geo, mat, items, PropsView.standard, { chunked: true, shadow: false });
  }

  /**
   * The corn maze's walls: one instance of ten stalks' cross-cards per segment, alpha-tested on the leaves' program and
   * swaying from the ground up (still on Low and software, where the wind is off). A car lays a segment flat (breakProp).
   */
  private buildCorn(corn: number[]): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, map: cornTexture(), alphaTest: 0.5, roughness: 0.86 });
    mat.name = 'corn';
    fadeNearCamera(mat, { shared: this.windUniforms, pivot: new THREE.Vector4(0, 0, 0, CORN_H) });
    mat.customProgramCacheKey = () => 'gta7-foliage-leaves';
    this.makeInstanced(cornGeometry(), mat, corn, PropsView.standard, { color: (p, c) => c.setRGB(0.92 + (p.color % 7) * 0.012, 0.95 + (p.color % 5) * 0.01, 0.9) });
  }

  /** Headstones, one batch per shape: three by a hash of the place, the epitaph stones their own. */
  private buildHeadstones(stones: number[]): void {
    const epitaph = new Set(attractionOf(this.world.layout, 'cemetery').anchors.epitaphs.map((e) => e.prop));
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0.05 });
    const shape = (i: number) => {
      const p = this.world.layout.props[i]!;
      return epitaph.has(i) ? HEADSTONE_SHAPES - 1 : hashInts(Math.round(p.x * 10), Math.round(p.z * 10)) % (HEADSTONE_SHAPES - 1);
    };
    for (let k = 0; k < HEADSTONE_SHAPES; k++) {
      // Weathered stones vary in tint; the polished granite does not.
      this.makeInstanced(headstoneGeometry(k), mat, stones.filter((i) => shape(i) === k), PropsView.standard, { color: (p, c) => c.setScalar(k === HEADSTONE_SHAPES - 1 ? 1 : 0.82 + (p.color % 64) / 360) });
    }
  }

  private buildPalms(palms: number[]): void {
    const rng = new Rng(78);
    const trunk = new THREE.MeshStandardMaterial({ color: 0xb29875, vertexColors: true, roughness: 0.95 });
    dissolveOccluder(trunk, OCCLUDER_AXIS.palm, this.occUniforms, PALM_OCC_BEND);
    const lean = (p: Prop, m: THREE.Matrix4) => palmMatrix(p, m);
    this.makeInstanced(palmTrunkGeometry(), trunk, palms, lean);
    const frondMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.84, side: THREE.DoubleSide });
    frondMat.name = 'palm-fronds';
    // The fronds sway more the further they reach from the crown (3 m to full sway).
    fadeNearCamera(frondMat, { shared: this.windUniforms, pivot: new THREE.Vector4(PALM_CROWN[0], PALM_CROWN[1], PALM_CROWN[2], 3) });
    frondMat.customProgramCacheKey = () => 'gta7-foliage-fronds';
    this.makeInstanced(palmFrondsGeometry(), frondMat, palms, lean, {
      color: (_p, c) => c.setHSL(0.25 + rng.range(-0.025, 0.025), 0.48, rng.range(0.29, 0.37)),
    });
  }

  /**
   * Where a lamp's light pool may lie: the deck or headland its pole stands on, else the land (not the sea or the
   * sloping beach, which lie below it). The pool is a flat sheet at the pole's foot, so past that it
   * would hang in the air.
   */
  poolClip(p: Prop): Rect {
    const L = this.world.layout;
    const deck = L.decks.find((d) => rectContains(d.rect, p.x, p.z));
    if (deck) return deck.rect;
    const head = L.headlands.flatMap((h) => h.rects).find((r) => rectContains(r, p.x, p.z));
    if (head) return head;
    const b = L.bounds;
    const clip = { minX: b.landMinX, minZ: b.landMinZ, maxX: b.beachStartX, maxZ: b.landMaxZ };
    // Short of the water beside it: the canal next to a sidewalk, a cove or basin next to a quay.
    for (const r of L.water.flatMap((w) => w.rects)) {
      if (p.z >= r.minZ && p.z <= r.maxZ) {
        if (r.minX >= p.x) clip.maxX = Math.min(clip.maxX, r.minX);
        else if (r.maxX <= p.x) clip.minX = Math.max(clip.minX, r.maxX);
      }
      if (p.x >= r.minX && p.x <= r.maxX) {
        if (r.minZ >= p.z) clip.maxZ = Math.min(clip.maxZ, r.minZ);
        else if (r.maxZ <= p.z) clip.minZ = Math.max(clip.minZ, r.maxZ);
      }
    }
    return clip;
  }

  private buildLamps(lamps: number[]): void {
    // Cast base, tapered pole with collars and an arm curving up and out to the back of the head (furniture.ts).
    const pole = lampPoleGeometry(LAMP_HEAD);
    // The pole, its head and its lens dissolve together, all by the pole's axis.
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x8b9199, vertexColors: true, roughness: 0.42, metalness: 0.55 });
    dissolveOccluder(poleMat, OCCLUDER_AXIS.lamp, this.occUniforms);
    // The drawn pole and head cast no shadow: a low-poly stand-in does (shadowProxies), one draw per cell.
    this.makeInstanced(pole, poleMat, lamps, PropsView.standard, { shadow: false });
    this.shadowProxies(lampShadowGeometry(LAMP_HEAD), poleMat, lamps, PropsView.standard);
    // The cobra head: a low dome 0.78 m long and 0.36 m wide on a closed rim, the lens set into its underside.
    const head = lampHeadGeometry(LAMP_HEAD);
    const headMat = new THREE.MeshStandardMaterial({ color: 0x9ea4ab, vertexColors: true, roughness: 0.38, metalness: 0.5 });
    dissolveOccluder(headMat, OCCLUDER_AXIS.lamp, this.occUniforms);
    this.makeInstanced(head, headMat, lamps, PropsView.standard, { shadow: false });
    const lens = lampLensGeometry(LAMP_HEAD);
    dissolveOccluder(this.bulbMat, OCCLUDER_AXIS.lamp, this.occUniforms);
    this.makeInstanced(lens, this.bulbMat, lamps, PropsView.standard, { shadow: false });
    const pool = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    // Per pool: the world rectangle (min x, min z, max x, max z) outside which it draws nothing (poolClip).
    const clip = new Float32Array(lamps.length * 4);
    lamps.forEach((pi, k) => {
      const r = this.poolClip(this.world.layout.props[pi]!);
      clip.set([r.minX, r.minZ, r.maxX, r.maxZ], k * 4);
    });
    pool.setAttribute('aClip', new THREE.InstancedBufferAttribute(clip, 4));
    // On a rise (the path up Azura Point's bluff, world/terrain.ts) a pool lies along the slope under it.
    const rises = this.world.layout.rises;
    const up = new THREE.Vector3(0, 1, 0);
    this.makeInstanced(pool, this.poolMat, lamps, (p, m) => {
      const fx = Math.sin(p.rot);
      const fz = Math.cos(p.rot);
      const r = LAMP_HEAD.reach * p.scale;
      const x = p.x + fx * r;
      const z = p.z + fz * r;
      const h = (dx: number, dz: number) => riseAt(rises, x + dx, z + dz);
      const slope = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(h(-1, 0) - h(1, 0), 2, h(0, -1) - h(0, 1)).normalize());
      m.compose(new THREE.Vector3(x, p.y + 0.04 + h(0, 0) - riseAt(rises, p.x, p.z), z), slope, new THREE.Vector3(LAMP_POOL, 1, LAMP_POOL));
    }, { shadow: false });
    // Each lamp's halo (LAMP_HALO), just under its bulb; a knocked-over lamp's goes dark (breakProp).
    if (lamps.length === 0) return;
    const haloPos = new Float32Array(lamps.length * 3);
    lamps.forEach((pi, k) => {
      haloPos.set(placed(this.world.layout.props[pi]!, 0, LAMP_HALO_Y, LAMP_HEAD.reach), k * 3);
      this.lampHaloIndex.set(pi, k);
    });
    const haloGeo = new THREE.BufferGeometry();
    haloGeo.setAttribute('position', new THREE.BufferAttribute(haloPos, 3));
    haloGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lamps.length * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage));
    const halos = new THREE.Points(haloGeo, haloMaterial(null, LAMP_HALO));
    halos.name = 'lampHalos';
    halos.visible = false;
    this.group.add(halos);
    this.lampHalos = halos;
  }

  private buildSignals(signals: number[]): void {
    const L = this.world.layout;
    // One model per style (signalStyle: a mast arm on an avenue, a bracket on a street, Dry Creek's span wire), the
    // heads' black and their borders' yellow in its vertex colours.
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0.35 });
    dissolveOccluder(poleMat, OCCLUDER_AXIS.signal, this.occUniforms);
    collapseSpares(poleMat, 'gta7-signal-pole');
    const depth = new THREE.MeshDepthMaterial();
    collapseSpares(depth, 'gta7-signal-depth');
    const styles = signals.map((i) => signalStyle(this.world.roads, L.props[i]!));
    for (const style of ['mast', 'bracket', 'span'] as const) {
      const own = signals.filter((_, k) => styles[k] === style);
      // A pole's second walk head faces the road to its approach's right: none at a T junction (walkAxes), and there it goes.
      const geo = signalGeometry(style);
      geo.setAttribute('aSpareOff', new THREE.InstancedBufferAttribute(Float32Array.from(own, (i) => (walkAxes(this.world.roads, L.props[i]!)[1] === null ? 1 : 0)), 1));
      this.makeInstanced(geo, poleMat, own, PropsView.standard, { depth });
    }
    this.signalProps = signals.map((i) => L.props[i]!);
    this.signalPropIndex = signals;
    // Every signal's lenses, countdown digits and walk figures citywide in one draw: a few thousand quads cost the GPU
    // nothing, and one buffer keeps a changed light to a few floats. Each quad takes its signal's matrix (tracked with
    // the pole, whose refs entry exists by now, so it falls with it and a new game stands it up again).
    const byStyle = new Map((['mast', 'bracket', 'span'] as const).map((style) => [style, signalQuads(signalLayout(style))]));
    const quads = styles.map((style) => byStyle.get(style)!);
    const count = quads.reduce((n, q) => n + q.length, 0);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.name = 'signal-lit';
    const place = new Float32Array(count * 4);
    const size = new Float32Array(count * 2);
    const lit = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const atlas = signalAtlas();
    const mat = new THREE.MeshBasicMaterial({ map: atlas });
    mat.name = 'signal-lit';
    dissolveOccluder(mat, OCCLUDER_AXIS.signal, this.occUniforms);
    litQuads(mat, this.litColors, this.litDots);
    mat.userData.contactShadow = false;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.name = 'signal-lit';
    mesh.castShadow = false;
    mesh.userData.propIndices = signals;
    // The quads stand round their signal's foot, not on the unit quad: its sphere is theirs.
    const reach = new THREE.Box3();
    const m = new THREE.Matrix4();
    const halos: number[] = [];
    const facing: number[] = [];
    const feet: number[] = [];
    let at = 0;
    signals.forEach((pi, k) => {
      const p = L.props[pi]!;
      PropsView.standard(p, m);
      const base = m.clone();
      // A walk head facing no crosswalk (a T junction's) stays blank, and so does the back of an arm's head where no
      // traffic comes from the other way (a T junction's stem).
      const crosses = walkAxes(this.world.roads, p);
      const opposite = hasOpposite(this.world.roads, p);
      const blank = quads[k]!.map((q) => ((q.role.kind === 'walk' || q.role.kind === 'walkCount') && crosses[q.role.walk] === null) || (q.back && !opposite));
      this.signalSlots.push({ first: at, roles: quads[k]!.map((q) => q.role), blank, halo: halos.length / 3, lenses: quads[k]!.filter((q) => q.role.kind === 'lens').length, pole: this.refs.get(pi)![0]!.mesh, shown: true });
      for (const q of quads[k]!) {
        if (q.role.kind !== 'lens') continue;
        halos.push(...placed(p, ...q.at));
        facing.push(Math.sin(p.rot + q.turn), 0, Math.cos(p.rot + q.turn));
        feet.push(p.x, p.y, p.z);
      }
      for (const [j, q] of quads[k]!.entries()) {
        place.set([q.at[0], q.at[1], q.at[2], q.turn], at * 4);
        size.set(blank[j] ? [0, 0] : [q.w, q.h], at * 2);
        reach.expandByPoint(new THREE.Vector3(...q.at));
        mesh.setMatrixAt(at, base);
        this.refs.get(pi)?.push({ mesh, index: at, base });
        at++;
      }
    });
    geo.setAttribute('aQuad', new THREE.InstancedBufferAttribute(place, 4));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 2));
    this.signalSizes = size.slice();
    geo.setAttribute('aLit', lit);
    geo.boundingSphere = reach.getBoundingSphere(new THREE.Sphere());
    geo.boundingSphere.radius += 0.5;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.signalLit = mesh;
    this.signalKeys = new Float64Array(signals.length).fill(-1);
    const haloGeo = new THREE.BufferGeometry();
    haloGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(halos), 3));
    haloGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(halos.length), 3).setUsage(THREE.DynamicDrawUsage));
    haloGeo.setAttribute('aFacing', new THREE.BufferAttribute(new Float32Array(facing), 3));
    haloGeo.setAttribute('aFoot', new THREE.BufferAttribute(new Float32Array(feet), 3));
    const glow = new THREE.Points(haloGeo, haloMaterial(signalGlowTexture(atlas), SIGNAL_HALO, this.occUniforms));
    glow.name = 'signalHalos';
    glow.visible = false;
    this.group.add(glow);
    this.signalHalos = glow;
  }

  /** What signal `i` shows at sim time `t`: the one scratch show, rewritten for each (read it before the next). */
  private showOf(i: number, t: number): SignalShow {
    if (this.brokenSignals.has(this.signalPropIndex[i]!)) return DARK_SIGNAL;
    return signalShow(this.world.roads, this.signalProps[i]!, t, this.scratch);
  }

  /**
   * Signal `i`'s lens `k` (0 red, 1 yellow, 2 green) of head `head` (0 the head on its pole): where it is drawn (world
   * space) and the colour it shows now (tests).
   */
  signalLens(i: number, head: number, k: number): { at: THREE.Vector3; color: THREE.Color } {
    const mesh = this.signalLit!;
    const slot = this.signalSlots[i]!;
    const q = slot.first + slot.roles.findIndex((r) => r.kind === 'lens' && r.head === head && r.k === k);
    const place = mesh.geometry.getAttribute('aQuad');
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(q, m);
    const at = new THREE.Vector3(place.getX(q), place.getY(q), place.getZ(q)).applyMatrix4(m);
    return { at, color: this.litColors[mesh.geometry.getAttribute('aLit').getY(q)]!.clone() };
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
    const hubY = p.y + FERRIS_HUB;
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
    // The axle, out to the A-frames' legs.
    rimParts.push(new THREE.CylinderGeometry(0.9, 0.9, 2 * FERRIS_LEG_Z + 0.6, 12).rotateX(Math.PI / 2));
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
    const halos = new THREE.Points(haloGeo, haloMaterial(null, FERRIS_HALO));
    halos.name = 'ferrisHalos';
    wheel.add(halos);
    wheel.position.set(p.x, hubY, p.z);
    wheel.rotation.y = p.rot;
    this.group.add(wheel);
    const gondolas = new THREE.InstancedMesh(merged([box(2.2, 2.0, 2.4, 0, -1.6, 0), box(0.1, 0.8, 0.1, 0, -0.3, 0)]), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }), 16);
    for (let i = 0; i < 16; i++) gondolas.setColorAt(i, new THREE.Color().setHSL(i / 16, 0.7, 0.55));
    gondolas.castShadow = true;
    this.group.add(gondolas);
    // A-frame supports: each leg straight from the hub through x = +-FERRIS_LEG_X at the prop's y, beside the deck, and on
    // down to the seabed (StaticWorld stands a post round it where it meets the water).
    const legs: THREE.BufferGeometry[] = [];
    const rise = hubY - p.y;
    const sink = p.y - SEABED_Y;
    const out = FERRIS_LEG_X * (1 + sink / rise);
    const len = Math.hypot(out, rise + sink);
    for (const z of [-FERRIS_LEG_Z, FERRIS_LEG_Z]) {
      for (const sx of [-1, 1]) {
        const g = new THREE.BoxGeometry(0.6, len, 0.6).translate(0, len / 2, 0);
        g.rotateZ(sx * Math.atan2(out, rise + sink));
        g.translate(sx * out, -sink, z);
        legs.push(g);
      }
    }
    const legMesh = new THREE.Mesh(merged(legs), steel);
    legMesh.name = 'ferrisLegs';
    legMesh.position.set(p.x, p.y, p.z);
    legMesh.rotation.y = p.rot;
    legMesh.castShadow = true;
    this.group.add(legMesh);
    this.ferris = { wheel, gondolas, lights, halos, x: p.x, y: hubY, z: p.z, rot: p.rot };
  }

  /** A moored cabin cruiser on the hull and cabin the sim's colliders use (boatModels.ts mooredBoat). */
  private buildBoat(p: Prop): void {
    const g = mooredBoat(p.color, paletteMaterial());
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
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, list: typeof all, scaleY = true, chunked = false): THREE.InstancedMesh | null => {
      if (list.length === 0) return null;
      if (!chunked) {
        const cells = new Map<string, typeof all>();
        for (const r of list) {
          const key = spatialKey(r.x, r.z, this.chunk);
          let cell = cells.get(key);
          if (!cell) cells.set(key, cell = []);
          cell.push(r);
        }
        if (cells.size > 1) {
          let first: THREE.InstancedMesh | null = null;
          for (const cell of cells.values()) {
            const mesh = inst(geo, mat, cell, scaleY, true);
            first ??= mesh;
          }
          return first;
        }
      }
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
      const cells = new Map<string, typeof antennas>();
      for (const r of antennas) {
        const key = spatialKey(r.x, r.z, this.chunk);
        let cell = cells.get(key);
        if (!cell) cells.set(key, cell = []);
        cell.push(r);
      }
      const geometry = new THREE.SphereGeometry(0.35, 8, 6);
      for (const cell of cells.values()) {
        const lights = new THREE.InstancedMesh(geometry, this.antennaMat, cell.length);
        cell.forEach((r, i) => {
          this.tmpM.makeTranslation(r.x, r.y + r.h + 0.2, r.z);
          lights.setMatrixAt(i, this.tmpM);
        });
        lights.instanceMatrix.needsUpdate = true;
        lights.computeBoundingSphere();
        this.group.add(lights);
        this.antennaLights ??= lights;
      }
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

  /**
   * The render-only dressing (dressing.ts): one instanced mesh per kind and cell, sharing one vertex-coloured material
   * (posters and the garage lamps' tubes have their own). Nothing here is tracked by breakProp or the occluders.
   */
  private buildDressing(items: readonly DressingItem[]): void {
    const builders: Record<DressingKind, () => THREE.BufferGeometry> = {
      umbrella: umbrellaGeometry, towel: towelGeometry, lounger: loungerGeometry, lifeguard: lifeguardGeometry, volleyball: volleyballGeometry, surfboard: surfboardGeometry,
      fence: fenceGeometry, mailbox: mailboxGeometry, shrub: shrubGeometry, planter: planterGeometry, wheelie: wheelieBinGeometry,
      rail: railGeometry, bollard: bollardGeometry, ironfence: ironFenceGeometry,
      workbench: workbenchGeometry, toolwall: toolWallGeometry, shelving: () => shelvingGeometry(0.5), wallshelf: () => shelvingGeometry(0.26), tyres: tyreStackGeometry,
      tyrerack: tyreRackGeometry, drum: drumGeometry, chest: toolChestGeometry, jack: jackGeometry, poster: posterGeometry, lamphousing: lampHousingGeometry, lamptube: lampTubeGeometry,
    };
    const byKind = new Map<DressingKind, DressingItem[]>();
    for (const it of items) {
      let l = byKind.get(it.kind);
      if (!l) byKind.set(it.kind, l = []);
      l.push(it);
    }
    // Flat or small pieces cast no shadow map shadow; the flattest also stay out of the contact-shadow pass.
    const shadowless: ReadonlySet<DressingKind> = new Set(['towel', 'poster', 'lamptube', 'toolwall', 'fence', 'ironfence', 'mailbox', 'planter', 'shrub', 'bollard', 'surfboard']);
    const noContact: ReadonlySet<DressingKind> = new Set(['towel', 'poster', 'lamptube', 'toolwall', 'fence', 'ironfence']);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const c = new THREE.Color();
    for (const [kind, list] of byKind) {
      const geo = builders[kind]();
      const mat = kind === 'poster' ? this.posterMat : kind === 'lamptube' ? this.tubeMat : this.dressMat;
      const cells = new Map<string, DressingItem[]>();
      for (const it of list) {
        const key = spatialKey(it.x, it.z, this.chunk);
        let cell = cells.get(key);
        if (!cell) cells.set(key, cell = []);
        cell.push(it);
      }
      const meshes: THREE.InstancedMesh[] = [];
      for (const cell of cells.values()) {
        const mesh = new THREE.InstancedMesh(geo, mat, cell.length);
        mesh.name = `dress-${kind}`;
        mesh.userData.dressing = kind;
        mesh.castShadow = !shadowless.has(kind);
        mesh.receiveShadow = kind !== 'lamptube';
        if (noContact.has(kind)) mesh.userData.contactShadow = false;
        cell.forEach((it, k) => {
          m.compose(new THREE.Vector3(it.x, it.y, it.z), q.setFromAxisAngle(up, it.rot), one);
          mesh.setMatrixAt(k, m);
          mesh.setColorAt(k, c.setHex(it.color));
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        this.group.add(mesh);
        meshes.push(mesh);
      }
      this.dressing.set(kind, meshes);
    }
  }

  private readonly dressMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.78, metalness: 0.05 });
  private readonly posterMat = new THREE.MeshStandardMaterial({ map: posterTexture(), roughness: 0.7 });
  /** Garage strip lights: always on, a soft white just under the bloom threshold. */
  private readonly tubeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 1.45, 1.3) });

  /** Knocks over a breakable prop in the given direction. */
  breakProp(index: number, dirX: number, dirZ: number): void {
    const refs = this.refs.get(index);
    if (!refs) return;
    const p = this.world.layout.props[index]!;
    const l = Math.hypot(dirX, dirZ) || 1;
    const axis = new THREE.Vector3(dirZ / l, 0, -dirX / l);
    let fall = new THREE.Matrix4().makeRotationAxis(axis, Math.PI / 2 - 0.08);
    // A cow goes over on her side, whichever way she was pushed, legs out.
    if (p.kind === 'cow') fall = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(Math.sin(p.rot), 0, Math.cos(p.rot)), -Math.sign(dirX * Math.cos(p.rot) - dirZ * Math.sin(p.rot) || 1) * (Math.PI / 2));
    const toOrigin = new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z);
    const back = new THREE.Matrix4().makeTranslation(p.x, p.y + (p.kind === 'lamp' || p.kind === 'signal' ? 0.15 : p.kind === 'cow' ? 0.4 : 0.2), p.z);
    // A knocked-down lamp goes completely, light and all, so no head, lens or glow is left hanging where it stood; a
    // smashed pumpkin goes in a burst of orange, the propane tank in its blast (renderer.ts), a pump up in its blast
    // (sim/dryCreek.ts).
    const hide = p.kind === 'hydrant' || p.kind === 'lamp' || p.kind === 'pumpkin' || p.kind === 'propane' || p.kind === 'pump';
    const moved = new Set<THREE.InstancedMesh>();
    for (const r of [...refs, ...(this.shadowRefs.get(index) ?? [])]) {
      let m: THREE.Matrix4;
      if (hide || r.mesh.material === this.poolMat || r.mesh.material === this.bulbMat) m = new THREE.Matrix4().makeScale(0, 0, 0);
      else m = back.clone().multiply(fall).multiply(toOrigin).multiply(r.base);
      r.mesh.setMatrixAt(r.index, m);
      moved.add(r.mesh);
    }
    PropsView.moved(moved);
    if (p.kind === 'signal') this.brokenSignals.add(index);
    const occ = this.occByProp.get(index);
    if (occ) {
      this.standUp(occ);
      if (hide) occ.hidden = true;
      else {
        const m = back.clone().multiply(fall).multiply(toOrigin);
        const v = new THREE.Vector3();
        occ.path = occ.path.map((q) => {
          v.set(q.x, q.y, q.z).applyMatrix4(m);
          return { x: v.x, y: v.y, z: v.z };
        });
        occ.base = occ.path[0]!;
        occ.top = occ.path[occ.path.length - 1]!;
        occ.fallen = true;
        this.occFallen.add(occ);
      }
    }
    const halo = this.lampHaloIndex.get(index);
    if (this.lampHalos && halo !== undefined) {
      const c = this.lampHalos.geometry.getAttribute('color') as THREE.BufferAttribute;
      c.setXYZ(halo, 0, 0, 0);
      c.needsUpdate = true;
    }
  }

  /**
   * The street lamps' lights, for wet-road streaks: each head's position (x, y, z), its colour attribute (1, 1, 1, or 0, 0, 0
   * once knocked over) and the colour they shine now (black by day). Null without lamps.
   */
  get lampLights(): { positions: Float32Array; on: Float32Array; color: THREE.Color } | null {
    const h = this.lampHalos;
    if (!h) return null;
    return {
      positions: h.geometry.getAttribute('position').array as Float32Array,
      on: h.geometry.getAttribute('color').array as Float32Array,
      color: h.material.color,
    };
  }

  /** An occluder's axis as it was built, upright at its prop. */
  private standUp(o: Occluder): void {
    const p = this.world.layout.props[o.index]!;
    const a = OCCLUDER_AXIS[o.kind];
    o.path = o.kind === 'palm' ? palmAxis(p) : [{ x: p.x, y: p.y + a.from * p.scale, z: p.z }, { x: p.x, y: p.y + a.to * p.scale, z: p.z }];
    o.base = o.path[0]!;
    o.top = o.path[o.path.length - 1]!;
    o.hidden = false;
    o.fallen = false;
    this.occFallen.delete(o);
  }

  /**
   * The camera's position and the subject it frames (the player's head on foot, the car when driving; null on the
   * title screen and with no game: nothing dissolves), for dissolving the poles and trunks in between (occluderFade).
   * The shader does the dissolve; here the batches holding one that is dissolving are kept out of the contact-shadow
   * depth pass, whose override material would draw them whole. Returns the prop indices dissolving now.
   */
  setOccluderView(cam: V3, subject: V3 | null): number[] {
    const u = this.occUniforms;
    for (const m of this.occFlagged) delete m.userData.contactShadow;
    this.occFlagged.clear();
    const out: number[] = [];
    if (!subject) {
      u.uOccFade.value.set(...OCCLUDER_OFF);
      return out;
    }
    u.uOccFade.value.set(...OCCLUDER_FADE_EDGES);
    u.uOccCam.value.set(cam.x, cam.y, cam.z);
    u.uOccSubject.value.set(subject.x, subject.y, subject.z);
    const check = (o: Occluder) => {
      if (o.hidden || occluderOpacityPath(cam, subject, o.path) >= 1) return;
      out.push(o.index);
      for (const r of this.refs.get(o.index) ?? []) {
        r.mesh.userData.contactShadow = false;
        this.occFlagged.add(r.mesh);
      }
    };
    // A curved palm's top leans up to 1.5 m off its foot.
    const pad = OCCLUDER_LENS_FAR + 1.5;
    const x0 = Math.floor((Math.min(cam.x, subject.x) - pad) / OCC_CELL);
    const x1 = Math.floor((Math.max(cam.x, subject.x) + pad) / OCC_CELL);
    const z0 = Math.floor((Math.min(cam.z, subject.z) - pad) / OCC_CELL);
    const z1 = Math.floor((Math.max(cam.z, subject.z) + pad) / OCC_CELL);
    // (A camera far from its subject, as on a cut, is not worth a sweep across the city: the shader still dissolves.)
    if ((x1 - x0 + 1) * (z1 - z0 + 1) <= 16) {
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          for (const o of this.occCells.get(`${cx},${cz}`) ?? []) if (!o.fallen) check(o);
        }
      }
    }
    for (const o of this.occFallen) check(o);
    return out;
  }

  /** The weather's wind (m/s, sim.weather.state.wind) for the foliage sway; none on the title screen. */
  setWind(wind: { readonly x: number; readonly z: number }): void {
    const speed = Math.hypot(wind.x, wind.z);
    this.windSpeed = speed;
    if (speed > 1e-3) this.windUniforms.uWindDir.value.set(wind.x / speed, wind.z / speed);
    this.windUniforms.uWindAmp.value = this.windOn ? windAmplitude(speed) : 0;
  }

  /** Foliage sways on High and Medium; Low and the software tier keep it still (GameRenderer.setQuality). */
  setWindEnabled(on: boolean): void {
    this.windOn = on;
    this.windUniforms.uWindAmp.value = on ? windAmplitude(this.windSpeed) : 0;
  }

  /** The wind uniforms now (tests, debug). */
  get wind(): { time: number; amp: number; dir: [number, number] } {
    const u = this.windUniforms;
    return { time: u.uWindTime.value, amp: u.uWindAmp.value, dir: [u.uWindDir.value.x, u.uWindDir.value.y] };
  }

  /** Whether bloom draws halos round bright lights (GameRenderer.setQuality): without it the warning lights use WARNING.flat. */
  setGlow(on: boolean): void {
    this.glow = on;
  }

  /** Stands the props `indices` up again (the county's cows at dawn). */
  restoreProps(indices: readonly number[]): void {
    const moved = new Set<THREE.InstancedMesh>();
    for (const i of indices) {
      for (const r of [...(this.refs.get(i) ?? []), ...(this.shadowRefs.get(i) ?? [])]) {
        r.mesh.setMatrixAt(r.index, r.base);
        moved.add(r.mesh);
      }
    }
    PropsView.moved(moved);
  }

  /** Puts every knocked-over prop back in place (new game). */
  restoreAll(): void {
    const moved = new Set<THREE.InstancedMesh>();
    for (const refs of [...this.refs.values(), ...this.shadowRefs.values()]) {
      for (const r of refs) {
        r.mesh.setMatrixAt(r.index, r.base);
        moved.add(r.mesh);
      }
    }
    PropsView.moved(moved);
    this.brokenSignals.clear();
    for (const o of this.occFallen) this.standUp(o);
    this.occFallen.clear();
    for (const o of this.occluders) o.hidden = false;
    if (this.lampHalos) {
      const c = this.lampHalos.geometry.getAttribute('color') as THREE.BufferAttribute;
      (c.array as Float32Array).fill(1);
      c.needsUpdate = true;
    }
  }

  /**
   * `time` drives the decorative animation only. `signalTime` must be the simulation clock
   * (sim.time) so the bulbs show the phase that drivers and pedestrians obey.
   */
  update(time: number, night: number, signalTime: number): void {
    this.windUniforms.uWindTime.value = time;
    // Lamps: the bulb, its halo added on top and the pool under it (see LAMP_HALO).
    const k = night;
    this.bulbMat.color.setRGB(0.25 + k * 1.35, 0.24 + k * 1.1, 0.22 + k * 0.7);
    this.poolMat.opacity = k * LAMP_POOL_GAIN;
    if (this.lampHalos) {
      this.lampHalos.material.color.copy(LAMP_HALO_COLOR).multiplyScalar(k);
      this.lampHalos.visible = k > 0.02;
    }
    for (const m of this.adMaterials) m.emissiveIntensity = 0.12 + k * 1.1;
    // Signals: unlit LEDs dimmer at night, with no daylight on them.
    const palette = this.litColors;
    const dim = 1 - 0.75 * night;
    palette[LIT.redOff]!.setRGB(0.12 * dim, 0.012 * dim, 0.01 * dim);
    palette[LIT.yellowOff]!.setRGB(0.11 * dim, 0.06 * dim, 0.008 * dim);
    palette[LIT.greenOff]!.setRGB(0.01 * dim, 0.09 * dim, 0.05 * dim);
    this.litDots.value = 0.045 * dim;
    // Each signal is rewritten only when what it shows changes: most frames a few signals (each junction counts down at
    // its own offset), the flashing hands of every junction in that phase twice a second. A lit lens's halo takes its
    // colour, a dark one none; at night they glow (see SIGNAL_HALO). Only the changed signals' slices go to the GPU (a
    // buffer's update ranges), or the whole buffer when too many changed (uploadRanges).
    const quads = this.signalLit;
    const glow = this.signalHalos;
    if (quads && glow) {
      const attr = quads.geometry.getAttribute('aLit') as THREE.InstancedBufferAttribute;
      const a = attr.array as Float32Array;
      const halo = glow.geometry.getAttribute('color') as THREE.BufferAttribute;
      const out: [number, number] = [0, 0];
      let changed = false;
      for (let i = 0; i < this.signalSlots.length; i++) {
        const slot = this.signalSlots[i]!;
        const show = this.showOf(i, signalTime);
        const key = showKey(show);
        if (key === this.signalKeys[i]) continue;
        this.signalKeys[i] = key;
        for (let j = 0; j < slot.roles.length; j++) {
          const role = slot.roles[j]!;
          a.set(quadLit(role, show, out), (slot.first + j) * 2);
          if (role.kind === 'lens') halo.setXYZ(slot.halo + role.head * 3 + role.k, ...(out[1] >= LIT.red && out[1] <= LIT.green && !slot.blank[j] ? SIGNAL_HALO_COLORS[role.k]! : NO_HALO));
        }
        attr.addUpdateRange(slot.first * 2, slot.roles.length * 2);
        halo.addUpdateRange(slot.halo * 3, slot.lenses * 3);
        changed = true;
      }
      if (changed) {
        uploadRanges(attr);
        uploadRanges(halo);
      }
      glow.material.color.setScalar(night);
      glow.visible = night > 0.02;
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
      if (on) this.antennaMat.color.setRGB(...WARNING[this.glow ? 'glow' : 'flat']);
      else this.antennaMat.color.setRGB(0.25, 0.02, 0.02);
    }
  }
}
