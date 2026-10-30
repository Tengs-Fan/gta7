// Street furniture and landmarks as instanced meshes, with night lighting,
// live traffic signal bulbs and breakable props.

import * as THREE from 'three';
import { mooredBoat } from './boatModels';
import { paletteMaterial } from './shapeKit';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { smoothstep, type V3 } from '../core/math';
import { Rng } from '../core/rng';
import { axisOf, type Dir } from '../world/roads';
import { SEABED_Y } from '../world/constants';
import { rectContains, type Prop, type PropKind, type Rect } from '../world/layout';
import { FERRIS_HUB, FERRIS_LEG_X, FERRIS_LEG_Z, type StaticWorld } from '../world/staticWorld';
import { adTexture, AD_COUNT, glowTexture, groundTexture } from './textures';
import { spatialKey, STATIC_CHUNK_SIZE, StaticVisibility } from './spatial';
import { OCCLUDER_AXIS, OCCLUDER_FADE_EDGES, OCCLUDER_GLSL, OCCLUDER_LENS_FAR, OCCLUDER_SEGMENTS, occluderAxisPoints, occluderOpacityPath, SIGNAL_BULB_AXIS, type OccluderKind } from './occluderFade';
import { broadleafClusters, broadleafGeometry, broadleafSamples, broadleafTexture, PALM_BEND, PALM_CROWN, PALM_TOP, palmFrondsGeometry, palmTrunkGeometry, treeTrunkGeometry } from './foliage';
import {
  benchGeometry, binGeometry, bollardGeometry, drumGeometry, fenceGeometry, hydrantGeometry, jackGeometry, lampHeadGeometry, lampHousingGeometry, lampLensGeometry, lampShadowGeometry,
  lampPoleGeometry, lampTubeGeometry, lifeguardGeometry, loungerGeometry, mailboxGeometry, planterGeometry, posterGeometry, railGeometry, shelvingGeometry, shrubGeometry,
  signalBulbAt, signalPoleGeometry, surfboardGeometry, toolChestGeometry, toolWallGeometry, towelGeometry, tyreRackGeometry, tyreStackGeometry, umbrellaGeometry,
  volleyballGeometry, wheelieBinGeometry, workbenchGeometry,
} from './furniture';
import { dressingItems, type DressingItem, type DressingKind } from './dressing';
import { WIND_GLSL, windAmplitude } from './wind';
import { SHADOW_LAYER } from './vehicleBatches';

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
function fadeNearCamera(mat: THREE.Material, wind?: WindPatch): void {
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
interface WindUniforms {
  uWindTime: { value: number };
  uWindAmp: { value: number };
  uWindDir: { value: THREE.Vector2 };
}

interface WindPatch {
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
const LAMP_HALO_Y = LAMP_HEAD.y - 0.08;
const LAMP_HALO_COLOR = new THREE.Color(0.65, 0.52, 0.33);

/** A halo is depth-tested as if this much (m) nearer the camera, so the lamp it glows round (its head, a tube) cannot cut into it. */
const HALO_PULL = 0.6;

/**
 * The additive glow round each point of a Points, coloured by its vertex colours, `size` m across but never under
 * HALO_MIN_PX pixels. `map` is the lamp pools' glow texture: on the GPU from the first frame, so lighting up at night
 * uploads nothing.
 */
function haloMaterial(map: THREE.Texture | null, size: number): THREE.PointsMaterial {
  const mat = new THREE.PointsMaterial({ size, map, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_vertex>',
      `#include <fog_vertex>
gl_PointSize = max( gl_PointSize, ${HALO_MIN_PX.toFixed(1)} );
gl_Position = projectionMatrix * vec4( mvPosition.xyz * max( 0.0, 1.0 - ${HALO_PULL.toFixed(2)} / length( mvPosition.xyz ) ), 1.0 );`,
    );
  };
  mat.customProgramCacheKey = () => 'gta7-halo';
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
  readonly visibility = new StaticVisibility();
  private readonly refs = new Map<number, InstanceRef[]>();
  /** Shadow-only stand-ins (SHADOW_LAYER) by prop index, moved with their prop by breakProp and restoreAll. */
  private readonly shadowRefs = new Map<number, InstanceRef[]>();
  private readonly bulbMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
  private readonly poolMat: THREE.MeshBasicMaterial;
  private signalBulbs: THREE.InstancedMesh | null = null;
  private readonly signalBatches: Array<{ mesh: THREE.InstancedMesh; slots: number[] }> = [];
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
  /** Whether a bloom pass draws halos round bright lights, which picks the coloured lamps' colours (see LAMPS). */
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
  /** Shared by every foliage material (windVertex); setWind and setWindEnabled drive it. */
  private readonly windUniforms: WindUniforms = { uWindTime: { value: 0 }, uWindAmp: { value: windAmplitude(0) }, uWindDir: { value: new THREE.Vector2(1, 0) } };
  private windOn = true;
  private windSpeed = 0;
  /** The dressing's instanced meshes by kind (beach, yards, decks, garages). */
  readonly dressing = new Map<DressingKind, THREE.InstancedMesh[]>();

  /** `chunk`: the cell size instances are batched in (one draw per prop shape and cell). */
  constructor(private readonly world: StaticWorld, private readonly chunk = STATIC_CHUNK_SIZE) {
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
    this.buildSimple(get('hydrant'), hydrantGeometry(), new THREE.MeshStandardMaterial({ color: 0xc0281c, vertexColors: true, roughness: 0.45, metalness: 0.1 }));
    this.buildSimple(get('bench'), benchGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.78, metalness: 0.15 }));
    this.buildSimple(get('bin'), binGeometry(), new THREE.MeshStandardMaterial({ color: 0x1e4d2b, vertexColors: true, roughness: 0.6, metalness: 0.3 }));
    this.buildContainers(get('container'));
    for (const i of get('fountain')) this.buildFountain(world.layout.props[i]!);
    for (const i of get('crane')) this.buildCrane(world.layout.props[i]!);
    for (const i of get('lighthouse')) this.buildLighthouse(world.layout.props[i]!);
    for (const i of get('ferris')) this.buildFerris(world.layout.props[i]!);
    for (const i of get('boat')) this.buildBoat(world.layout.props[i]!);
    get('billboard').forEach((i, k) => this.buildBillboard(world.layout.props[i]!, k));
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
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) this.visibility.add(o, 8);
    });
  }

  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, props: number[], matrixFor: (p: Prop, m: THREE.Matrix4) => void, opts: { shadow?: boolean; color?: (p: Prop, c: THREE.Color) => void; track?: boolean; chunked?: boolean } = {}): THREE.InstancedMesh | null {
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

  private buildTrees(trees: number[], bushes: number[]): void {
    const rng = new Rng(77);
    const trunk = new THREE.MeshStandardMaterial({ color: 0x725440, vertexColors: true, roughness: 0.96 });
    dissolveOccluder(trunk, OCCLUDER_AXIS.tree, this.occUniforms);
    this.makeInstanced(treeTrunkGeometry(), trunk, trees, PropsView.standard);
    // Leaf cards: alpha-tested (never sorted), the atlas's own greens with a per-tree tint, swaying in the wind.
    const leafMaterial = (name: string): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, map: broadleafTexture(), alphaTest: 0.5, roughness: 0.86 });
      m.name = name;
      fadeNearCamera(m, { shared: this.windUniforms, pivot: new THREE.Vector4(0, 0, 0, 0) });
      m.customProgramCacheKey = () => 'gta7-foliage-leaves';
      return m;
    };
    const tint = new THREE.Color();
    this.makeInstanced(broadleafGeometry('tree'), leafMaterial('broadleaf-canopy'), trees, PropsView.standard, {
      color: (_p, c) => c.setRGB(1, 1, 1).lerp(tint.setHSL(0.24 + rng.range(-0.04, 0.04), rng.range(0.34, 0.52), rng.range(0.42, 0.55)), 0.45),
    });
    this.makeInstanced(broadleafGeometry('bush'), leafMaterial('broadleaf-shrub'), bushes, PropsView.standard, {
      color: (_p, c) => c.setRGB(1, 1, 1).lerp(tint.setHSL(0.27 + rng.range(-0.03, 0.03), 0.43, rng.range(0.4, 0.5)), 0.5),
      shadow: false,
    });
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
    return { minX: b.landMinX, minZ: b.landMinZ, maxX: b.beachStartX, maxZ: b.landMaxZ };
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
    this.makeInstanced(pool, this.poolMat, lamps, (p, m) => {
      const fx = Math.sin(p.rot);
      const fz = Math.cos(p.rot);
      const r = LAMP_HEAD.reach * p.scale;
      m.compose(new THREE.Vector3(p.x + fx * r, p.y + 0.04, p.z + fz * r), new THREE.Quaternion(), new THREE.Vector3(13, 1, 13));
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
    const halos = new THREE.Points(haloGeo, haloMaterial(this.poolMat.map, LAMP_HALO));
    halos.name = 'lampHalos';
    halos.visible = false;
    this.group.add(halos);
    this.lampHalos = halos;
  }

  private buildSignals(signals: number[]): void {
    const L = this.world.layout;
    const pole = signalPoleGeometry();
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b2d30, vertexColors: true, roughness: 0.55, metalness: 0.4 });
    dissolveOccluder(poleMat, OCCLUDER_AXIS.signal, this.occUniforms);
    this.makeInstanced(pole, poleMat, signals, PropsView.standard);
    this.signalProps = signals.map((i) => L.props[i]!);
    this.signalPropIndex = signals;
    // Three bulbs per signal.
    // Low-poly bulbs: there are three per signal head, citywide.
    const bulb = new THREE.IcosahedronGeometry(0.11, 0);
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    dissolveOccluder(bulbMat, SIGNAL_BULB_AXIS, this.occUniforms);
    const mesh = new THREE.InstancedMesh(bulb, bulbMat, signals.length * 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    signals.forEach((pi, k) => {
      const p = L.props[pi]!;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot);
      for (let b = 0; b < 3; b++) {
        v.set(...signalBulbAt(b)).applyQuaternion(q);
        m.makeTranslation(p.x + v.x, p.y + v.y, p.z + v.z);
        mesh.setMatrixAt(k * 3 + b, m);
        mesh.setColorAt(k * 3 + b, new THREE.Color(0x111111));
        // Tracked with the pole (whose refs entry exists by now) so breakProp hides them and restoreAll restores them.
        this.refs.get(pi)?.push({ mesh, index: k * 3 + b, base: m.clone() });
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.signalBulbs = mesh;
    // A logical citywide buffer keeps signal indexing stable; only its spatial slices are drawn.
    const cells = new Map<string, number[]>();
    signals.forEach((pi, k) => {
      const p = L.props[pi]!;
      const key = spatialKey(p.x, p.z, this.chunk);
      let slots = cells.get(key);
      if (!slots) cells.set(key, slots = []);
      slots.push(k * 3, k * 3 + 1, k * 3 + 2);
    });
    for (const slots of cells.values()) {
      const part = new THREE.InstancedMesh(bulb, mesh.material, slots.length);
      part.userData.signalBulbs = true;
      slots.forEach((slot, k) => {
        mesh.getMatrixAt(slot, m);
        part.setMatrixAt(k, m);
        part.setColorAt(k, new THREE.Color(0x111111));
        const pi = signals[Math.floor(slot / 3)]!;
        this.refs.get(pi)?.push({ mesh: part, index: k, base: m.clone() });
      });
      part.computeBoundingSphere();
      this.group.add(part);
      this.signalBatches.push({ mesh: part, slots });
    }
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
    const halos = new THREE.Points(haloGeo, haloMaterial(this.poolMat.map, FERRIS_HALO));
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
      rail: railGeometry, bollard: bollardGeometry,
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
    const shadowless: ReadonlySet<DressingKind> = new Set(['towel', 'poster', 'lamptube', 'toolwall', 'fence', 'mailbox', 'planter', 'shrub', 'bollard', 'surfboard']);
    const noContact: ReadonlySet<DressingKind> = new Set(['towel', 'poster', 'lamptube', 'toolwall', 'fence']);
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
    const fall = new THREE.Matrix4().makeRotationAxis(axis, Math.PI / 2 - 0.08);
    const toOrigin = new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z);
    const back = new THREE.Matrix4().makeTranslation(p.x, p.y + (p.kind === 'lamp' || p.kind === 'signal' ? 0.15 : 0.2), p.z);
    // A knocked-down lamp goes completely, light and all, so no head, lens or glow is left hanging where it stood.
    const hide = p.kind === 'hydrant' || p.kind === 'lamp';
    for (const r of [...refs, ...(this.shadowRefs.get(index) ?? [])]) {
      let m: THREE.Matrix4;
      if (hide || r.mesh.material === this.poolMat || r.mesh.material === this.bulbMat || r.mesh === this.signalBulbs || r.mesh.userData.signalBulbs) m = new THREE.Matrix4().makeScale(0, 0, 0);
      else m = back.clone().multiply(fall).multiply(toOrigin).multiply(r.base);
      r.mesh.setMatrixAt(r.index, m);
      r.mesh.instanceMatrix.needsUpdate = true;
      r.mesh.computeBoundingSphere();
    }
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

  /** Whether bloom draws halos round bright lights (GameRenderer.setQuality): without it the coloured lamps use LAMPS.flat. */
  setGlow(on: boolean): void {
    this.glow = on;
  }

  /** Puts every knocked-over prop back in place (new game). */
  restoreAll(): void {
    for (const refs of [...this.refs.values(), ...this.shadowRefs.values()]) {
      for (const r of refs) {
        r.mesh.setMatrixAt(r.index, r.base);
        r.mesh.instanceMatrix.needsUpdate = true;
        r.mesh.computeBoundingSphere();
      }
    }
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
    this.poolMat.opacity = k * 0.42;
    if (this.lampHalos) {
      this.lampHalos.material.color.copy(LAMP_HALO_COLOR).multiplyScalar(k);
      this.lampHalos.visible = k > 0.02;
    }
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
      for (const batch of this.signalBatches) {
        batch.slots.forEach((slot, k) => {
          bulbs.getColorAt(slot, this.tmpC);
          batch.mesh.setColorAt(k, this.tmpC);
        });
        if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
      }
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
