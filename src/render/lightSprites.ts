// Vehicle lights that read at night without real light sources: camera-facing lamp glows, the light of lit cars'
// headlights on the ground ahead of them, and light streaks on a wet road. The glows and streaks are a batch each, one
// draw call, on every tier; the headlights light the ground in its own shading (lightGround: uniforms, no draw), and on
// the software tier, which has no such shading, they are a painted batch.

import * as THREE from 'three';

/** UnrealBloomPass's luminance threshold (GameRenderer). Every glow stays under it, so bloom never toggles on one. */
export const BLOOM_THRESHOLD = 2.6;

export type GlowKind = 'head' | 'tail' | 'brake' | 'reverse' | 'sirenRed' | 'sirenBlue'
  | 'reflector';

type Rgb = readonly [number, number, number];

/**
 * Each glow's colour at its centre (linear, intensity included) and its size in metres. The brake glow is 2.2 times the
 * running tail glow; reverse lamps are white.
 */
export const GLOW: Readonly<Record<GlowKind, { readonly color: Rgb; readonly size: number }>> = {
  head: { color: [1.5, 1.38, 1.1], size: 1.15 },
  tail: { color: [0.9, 0.06, 0.025], size: 0.8 },
  brake: { color: [1.98, 0.13, 0.055], size: 0.85 },
  reverse: { color: [1.1, 1.1, 1.05], size: 0.8 },
  sirenRed: { color: [3, 0.12, 0.05], size: 1.7 },
  sirenBlue: { color: [0.08, 0.35, 3.2], size: 1.7 },
  /** A roadside post's amber reflector caught full in a car's headlights (render/country/reflectors.ts). */
  reflector: { color: [1.6, 0.82, 0.22], size: 0.45 },
};

/** One lamp's glow: its world position and the horizontal direction it shines (fx = fz = 0: all round). */
export interface LampGlow {
  kind: GlowKind;
  x: number;
  y: number;
  z: number;
  fx: number;
  fz: number;
}

export const GLOW_CAPACITY = 512;
export const STREAK_CAPACITY = 64;
/** Lights farther than this (m) from the camera, and ground drier than STREAK_MIN_WET, get no streak. */
export const STREAK_RANGE = 60;
const STREAK_MIN_WET = 0.01;
/** Streaks of lights nearer the camera than this (m) are faded out, full from three times as far. */
const STREAK_NEAR = 4;
/**
 * A wet road mirrors a light as water does, by Schlick's Fresnel with water's 0.02 head on: barely where the camera
 * looks down at the mirror point (a lamp beside it), strongly at grazing angles (a lamp down the street). A streak is
 * at full strength where that reflectance reaches STREAK_FRESNEL, about 73 degrees off the vertical (a street lamp 30 m
 * off), and weaker in proportion above that.
 */
const STREAK_FRESNEL = 0.2;

/** Schlick's Fresnel reflectance of water at a view `cos` the angle off the surface's normal. */
export function waterFresnel(cos: number): number {
  return 0.02 + 0.98 * (1 - cos) ** 5;
}
/** Fixed lights (street lamps) offered for streaks in a frame. */
const LIGHT_CAPACITY = 512;
/** Glows, and headlights on the ground, farther than this from the camera are not drawn (a few pixels, mostly fogged). */
export const GLOW_RANGE = 140;
export const POOL_RANGE = 90;
/**
 * The cars whose headlights light the ground, on every tier: the player's own, when its lamps are lit, always at its full
 * strength, and the lit ones nearest the camera for the rest of the HEADLIGHTS. Each of those fades out over the last
 * POOL_FADE m before the cut (the next car's distance, or POOL_RANGE), so cars coming into the nearest few, or leaving
 * them, do not pop. The player's is outside the ranking: its bumper is about 11 m from the chase camera, so in a queue
 * of lit cars it would otherwise rank among the farthest and dim.
 */
export const HEADLIGHTS = 8;
export const POOL_FADE = 5;
/**
 * The headlight pool on the ground: from POOL_START m ahead of the bumper, POOL_LENGTH m long (the light ends 50 m out), and
 * POOL_WIDTH m wide at the bumper, widening with distance (POOL_SHAPE's `widen`).
 */
export const POOL_START = 2;
export const POOL_LENGTH = 48;
export const POOL_WIDTH = 9;
/**
 * The headlights' irradiance where the pool is brightest (a `poolShape` of 1), at full strength (both head lamps, full
 * night), in three's light units: the ground there gains its albedo / pi times this, as from any other light, so the
 * same headlights add the same light to a dark county road and to lamp-lit asphalt. Warm, so the light is a little yellow.
 */
export const POOL_LIGHT: Rgb = [12, 10.3, 7.6];
/** The colour a painted pool (the software tier's) adds at a `poolShape` of 1, at full strength. */
export const POOL_PAINT: Rgb = [0.17, 0.15, 0.11];
/**
 * The most luminance (three's light units, before tone mapping) the headlights add to a field's ground or plants. Lit as
 * asphalt is, by albedo times irradiance, pale straw takes ten times the asphalt's light and reads as a shining patch
 * (luma 210 to 250 where the asphalt reads 78), so a field keeps what the headlights add where that is small (up to 0.05
 * within 3 per cent: dark soil, furrows) and takes `fieldLight` of it where it is large, never more than this however
 * pale the straw or many the lights: the straw then reads as bright as lit pavement (luma 140).
 */
export const FIELD_LIGHT_MAX = 0.2;
/** What a field keeps of a luminance `y` that the headlights would add: the fragment shader's maths, for tests. */
export function fieldLight(y: number): number {
  return y / Math.sqrt(1 + (y / FIELD_LIGHT_MAX) ** 2);
}
/** The head lamps sit this far (m) either side of the car's axis, and this high (m) over the road. */
const POOL_LAMP_X = 0.72;
const POOL_LAMP_Y = 0.65;
/** Ground this far (m) off the road's plane under the beam (a bridge deck over the road, the foot of a quay) gets none. */
const POOL_BAND = 1.5;
/**
 * The pool's shape: each lamp's lobe is `lobe` m wide (sigma) at the bumper and widens by `spread` per metre; the light
 * holds up to about `reach` m and falls away beyond it as 1 / (1 + (d / reach) ** power) with the distance d from the
 * bumper (a low beam throws its light well down the road and then cuts off), rises from nothing over the first `rise` of
 * the decal's length and dies away from `taper` of it to the far end; the sides fade out from `side` of the half width,
 * which is POOL_WIDTH / 2 at the bumper and `widen` more per metre of d. `peak` scales the sum of the two lobes.
 */
const POOL_SHAPE = { lobe: 0.22, spread: 0.05, reach: 30, power: 4, rise: 0.12, taper: 0.75, side: 0.6, peak: 0.36, widen: 0.08 };
/** The painted pool's decal is as wide as the light is at the far end, where it ends. */
const POOL_DECAL_WIDTH = POOL_WIDTH + 2 * POOL_SHAPE.widen * (POOL_START + POOL_LENGTH);
/** The half width (m) of the pool at `d` m ahead of the bumper. */
export const poolHalfWidth = (d: number): number => POOL_WIDTH / 2 + POOL_SHAPE.widen * d;

/**
 * A pool's light 0..1 at `d` m ahead of the bumper and `x` m off the car's axis: the fragment shader's maths, for tests.
 * Two lobes, one per lamp, show just ahead of the bumper and run into one a few metres on; the light climbs over the first
 * metres to a broad hot zone 13 to 25 m out, where it is within about a fifth of its best, then falls away to half of it
 * by 33 m, and to nothing at the far end, 50 m out, in a beam that widens all the way.
 */
export function poolShape(d: number, x: number): number {
  const S = POOL_SHAPE;
  const t = (d - POOL_START) / POOL_LENGTH;
  const sigma = S.lobe + S.spread * d;
  const lobes = Math.exp(-0.5 * ((x + POOL_LAMP_X) / sigma) ** 2) + Math.exp(-0.5 * ((x - POOL_LAMP_X) / sigma) ** 2);
  const along = (THREE.MathUtils.smoothstep(t, 0, S.rise) / (1 + (d / S.reach) ** S.power)) * (1 - THREE.MathUtils.smoothstep(t, S.taper, 1));
  return S.peak * lobes * along * (1 - THREE.MathUtils.smoothstep(Math.abs(x) / poolHalfWidth(d), S.side, 1));
}
/** Glows never shrink under this many pixels, so a distant lamp does not flicker as it crosses pixel boundaries. */
const GLOW_MIN_PX = 3;
/** Depth-tested as if this much (m) nearer the camera, so the lamp's own lens does not cut into its glow. */
const GLOW_PULL = 0.3;

const FOG_FADE = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    a *= exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    a *= 1.0 - smoothstep( fogNear, fogFar, vFogDepth );
  #endif
#endif`;

const GLOW_VS = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
uniform float uPixelsPerMetre;
varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_PointSize = max( aSize * uPixelsPerMetre / max( 0.05, - mvPosition.z ), ${GLOW_MIN_PX.toFixed(1)} );
  gl_Position = projectionMatrix * vec4( mvPosition.xyz * max( 0.0, 1.0 - ${GLOW_PULL.toFixed(2)} / length( mvPosition.xyz ) ), 1.0 );
  #include <fog_vertex>
}`;

const GLOW_FS = /* glsl */ `
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot( c, c );
  if ( r2 >= 1.0 ) discard;
  // A bright core in a soft skirt; 1 at the centre, so the centre colour is GLOW's.
  float skirt = ( 1.0 - r2 ) * ( 1.0 - r2 );
  float a = skirt * ( 0.3 + 0.7 * exp( - r2 * 9.0 ) );
  ${FOG_FADE}
  gl_FragColor = vec4( vColor * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Instanced flat decals: uv.x across, uv.y along (0 near the light, 1 far). */
const DECAL_VS = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vColor = vec3( 1.0 );
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #endif
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

/** poolShape's maths in GLSL, as `float poolShape( float d, float x )`. */
function poolShapeGlsl(): string {
  const S = POOL_SHAPE;
  const f = (n: number): string => n.toFixed(3);
  return /* glsl */ `
float poolShape( float d, float x ) {
  float t = ( d - ${f(POOL_START)} ) / ${f(POOL_LENGTH)};
  float sigma = ${f(S.lobe)} + ${f(S.spread)} * d;
  vec2 off = ( x - vec2( -${f(POOL_LAMP_X)}, ${f(POOL_LAMP_X)} ) ) / sigma;
  vec2 lobe = exp( -0.5 * off * off );
  float along = smoothstep( 0.0, ${f(S.rise)}, t ) / ( 1.0 + pow( d / ${f(S.reach)}, ${f(S.power)} ) ) * ( 1.0 - smoothstep( ${f(S.taper)}, 1.0, t ) );
  return ${f(S.peak)} * ( lobe.x + lobe.y ) * along * ( 1.0 - smoothstep( ${f(S.side)}, 1.0, abs( x ) / ( ${f(POOL_WIDTH / 2)} + ${f(S.widen)} * d ) ) );
}`;
}

/**
 * The software tier's painted pool: an 8-bit canvas has no ground shading to light, and its road is nearly black, so the
 * pool is a colour (POOL_PAINT) added like the glows, with the same shape, fading in fog.
 */
export function poolFragment(): string {
  return /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
#include <fog_pars_fragment>
${poolShapeGlsl()}
void main() {
  float a = poolShape( ${POOL_START.toFixed(3)} + vUv.y * ${POOL_LENGTH.toFixed(3)}, ( vUv.x - 0.5 ) * ${POOL_DECAL_WIDTH.toFixed(3)} );
  ${FOG_FADE}
  gl_FragColor = vec4( vColor * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
}

/**
 * The headlights of the HEADLIGHTS cars nearest the camera, for the ground's shading: per car the bumper on the ground
 * (x, y, z) and the strength (0..1), and its heading (fx, fz) and the ground's rise per metre ahead. The first
 * `uHeadCount` are this frame's; the rest are stale.
 */
export interface HeadlightUniforms {
  uHeadA: { value: Float32Array };
  uHeadB: { value: Float32Array };
  uHeadCount: { value: number };
}

/**
 * The ground's light from the headlights (lightGround): at each fragment, the pool's shape in the car's frame times its
 * strength, nothing off the road's plane, and nothing on ground facing away from the lamps (a kerb's far side, the road
 * past a crest); then added to the direct diffuse light, so it takes the surface's albedo, wetness and fog like every
 * other light. A field's (`field`) is held under FIELD_LIGHT_MAX first.
 */
function headlightGlsl(field: boolean): { vertexPars: string; vertex: string; fragmentPars: string; fragment: string } {
  const f = (n: number): string => n.toFixed(3);
  return {
    vertexPars: /* glsl */ `
varying vec3 vHeadPos;`,
    vertex: /* glsl */ `
vec4 headWorld = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
headWorld = instanceMatrix * headWorld;
#endif
vHeadPos = ( modelMatrix * headWorld ).xyz;`,
    fragmentPars: /* glsl */ `
uniform vec4 uHeadA[ ${HEADLIGHTS} ];
uniform vec4 uHeadB[ ${HEADLIGHTS} ];
uniform int uHeadCount;
varying vec3 vHeadPos;
${poolShapeGlsl()}`,
    fragment: /* glsl */ `
{
  vec3 headN = inverseTransformDirection( nonPerturbedNormal, viewMatrix );
  float headE = 0.0;
  for ( int i = 0; i < ${HEADLIGHTS}; i ++ ) {
    if ( i >= uHeadCount ) break;
    vec4 a = uHeadA[ i ];
    vec4 b = uHeadB[ i ];
    vec3 r = vHeadPos - a.xyz;
    float d = dot( r.xz, b.xy );
    float x = r.x * b.y - r.z * b.x;
    if ( d <= ${f(POOL_START)} || d >= ${f(POOL_START + POOL_LENGTH)} || abs( x ) >= ${f(POOL_WIDTH / 2)} + ${f(POOL_SHAPE.widen)} * d ) continue;
    float band = 1.0 - smoothstep( ${f(POOL_BAND)}, ${f(POOL_BAND * 2)}, abs( r.y - b.z * d ) );
    float facing = clamp( dot( headN, vec3( 0.0, ${f(POOL_LAMP_Y)}, 0.0 ) - r ) * 4.0, 0.0, 1.0 );
    headE += a.w * poolShape( d, x ) * band * facing;
  }
  vec3 headLit = BRDF_Lambert( material.diffuseColor ) * vec3( ${POOL_LIGHT.map(f).join(', ')} ) * headE;${field ? `
  float headY = dot( headLit, vec3( 0.2126, 0.7152, 0.0722 ) ) / ${f(FIELD_LIGHT_MAX)};
  headLit *= inversesqrt( 1.0 + headY * headY );` : ''}
  reflectedLight.directDiffuse += headLit;
}`,
  };
}

/** The head of three's loop over the spot lights in `lights_fragment_begin`. */
const SPOT_LOOP = '#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )';

const STREAK_FS = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  float s = abs( vUv.x - 0.5 ) * 2.0;
  float t = abs( vUv.y - 0.5 ) * 2.0;
  float a = ( 1.0 - smoothstep( 0.2, 1.0, s ) ) * ( 1.0 - smoothstep( 0.3, 1.0, t ) );
  ${FOG_FADE}
  gl_FragColor = vec4( vColor * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function additive(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform> = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, uniforms]),
    fog: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

/** A unit decal on the ground plane: x across (-0.5..0.5), z along (0..1), uv.y running with z. */
function decalGeometry(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2).translate(0, 0, 0.5);
}

/** Luminance with the weights of three's bloom high pass. */
export function glowLuminance(kind: GlowKind): number {
  const w = THREE.ColorManagement.getLuminanceCoefficients(new THREE.Vector3());
  const [r, g, b] = GLOW[kind].color;
  return w.x * r + w.y * g + w.z * b;
}

/** A car offering a headlight pool: bumper position on the ground, heading, strength 0..1, squared distance to the camera. */
interface PoolCandidate {
  x: number;
  z: number;
  heading: number;
  strength: number;
  d2: number;
}

export class LightSprites {
  readonly group = new THREE.Group();
  readonly glows: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** The software tier's painted pools (see poolFragment); null where the ground's shading takes the headlights. */
  readonly pools: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null;
  readonly streaks: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** The nearest lit cars' headlights for the ground's shading (lightGround), written by finish. */
  readonly headlights: HeadlightUniforms = {
    uHeadA: { value: new Float32Array(HEADLIGHTS * 4) },
    uHeadB: { value: new Float32Array(HEADLIGHTS * 4) },
    uHeadCount: { value: 0 },
  };
  /** The street lamps' haze (see LampHaze), attached once the props are built. */
  readonly haze: LampHaze;
  /** Ground wetness 0..1 (set before begin): streaks are drawn only on a wet road. */
  wet = 0;
  /**
   * How dark the scene is (max(night, weather dim)), set before finish. Streaks scale with it once more: by day the
   * sky-lit road outshines a lamp's reflection, and lamps lit only by the weather's dimming would otherwise streak as
   * brightly as at night.
   */
  dark = 1;
  private glowCount = 0;
  private poolCount = 0;
  private streakCount = 0;
  /** Fixed lights offered this frame (offerStreakLight): x, y, z, r, g, b each. */
  private readonly lights = new Float32Array(LIGHT_CAPACITY * 6);
  private lightCount = 0;
  private readonly bestD = new Float32Array(STREAK_CAPACITY);
  private readonly bestI = new Int32Array(STREAK_CAPACITY);
  private readonly glowPos: THREE.BufferAttribute;
  private readonly glowColor: THREE.BufferAttribute;
  private readonly glowSize: THREE.BufferAttribute;
  /** The other cars, kept nearest first, at most HEADLIGHTS + 1 long (the last is where the light of the others has faded out). */
  private readonly candidates: PoolCandidate[] = [];
  /** The player's own car, when it offered its headlights this frame. */
  private readonly own: PoolCandidate = { x: 0, z: 0, heading: 0, strength: 0, d2: 0 };
  private hasOwn = false;
  private readonly spare: PoolCandidate[] = [];
  private readonly cam = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  /** `paint`: on an 8-bit canvas with no ground shading to light (the software tier), the pools are painted (see poolFragment). */
  constructor(paint = false) {
    this.group.name = 'light-sprites';
    const geo = new THREE.BufferGeometry();
    this.glowPos = new THREE.BufferAttribute(new Float32Array(GLOW_CAPACITY * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.glowColor = new THREE.BufferAttribute(new Float32Array(GLOW_CAPACITY * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.glowSize = new THREE.BufferAttribute(new Float32Array(GLOW_CAPACITY), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.glowPos);
    geo.setAttribute('aColor', this.glowColor);
    geo.setAttribute('aSize', this.glowSize);
    geo.setDrawRange(0, 0);
    this.glows = new THREE.Points(geo, additive(GLOW_VS, GLOW_FS, { uPixelsPerMetre: { value: 800 } }));
    this.glows.name = 'lamp-glows';
    this.pools = paint ? this.decals('headlight-pools', additive(DECAL_VS, poolFragment()), HEADLIGHTS) : null;
    this.streaks = this.decals('light-streaks', additive(DECAL_VS, STREAK_FS), STREAK_CAPACITY);
    for (const o of [this.glows, this.streaks, ...(this.pools ? [this.pools] : [])]) {
      // Positions change every frame; the bounds would always be stale.
      o.frustumCulled = false;
      o.renderOrder = 2;
      this.group.add(o);
    }
    this.haze = new LampHaze(this.group);
  }

  private decals(name: string, material: THREE.ShaderMaterial, capacity: number): THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
    const mesh = new THREE.InstancedMesh(decalGeometry(), material, capacity);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Created now so the instanced-colour variant is the one compiled at warm-up.
    mesh.setColorAt(0, this.c.setRGB(0, 0, 0));
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  }

  get counts(): { glows: number; pools: number; streaks: number } {
    return { glows: this.glowCount, pools: this.poolCount, streaks: this.streakCount };
  }

  /**
   * Has the ground's own shading take the headlights (headlightGlsl): patches each material, before it is first drawn,
   * on top of any patch already on it. They all share `headlights`, so no program changes while the cars move.
   * `field`: the crop fields' ground and plants, whose pale straw and many upright leaves the road's rule would turn into a
   * shining patch: what the headlights add is held under FIELD_LIGHT_MAX, and no spot light shines on them: the player's,
   * whose inverse square a plant in front of the bumper takes in full, is the only one in reach (a street lamp's spot
   * reaches 22 m, and the nearest lamp is 72 m from a field); the headlights' own light lights them, as it lights the soil.
   */
  lightGround(materials: Iterable<THREE.Material>, field = false): void {
    const glsl = headlightGlsl(field);
    for (const mat of materials) {
      const prev = mat.onBeforeCompile.bind(mat);
      const prevKey = mat.customProgramCacheKey.bind(mat);
      mat.onBeforeCompile = (shader, renderer) => {
        prev(shader, renderer);
        Object.assign(shader.uniforms, this.headlights);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>${glsl.vertexPars}`)
          .replace('#include <project_vertex>', `#include <project_vertex>${glsl.vertex}`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>${glsl.fragmentPars}`)
          .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>${glsl.fragment}`);
        if (field) shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(SPOT_LOOP, '#if 0'));
      };
      mat.customProgramCacheKey = () => `${prevKey()}|gta7-headlights${field ? '-field' : ''}`;
    }
  }

  /** Starts a frame. `pixelsPerMetre`: drawing-buffer height / (2 tan(fov / 2)), a metre's size in pixels 1 m away. */
  begin(camera: THREE.Vector3, pixelsPerMetre: number): void {
    this.cam.copy(camera);
    this.glows.material.uniforms.uPixelsPerMetre!.value = pixelsPerMetre;
    this.glowCount = 0;
    this.lightCount = 0;
    this.hasOwn = false;
    for (const c of this.candidates) this.spare.push(c);
    this.candidates.length = 0;
  }

  /** Adds a lamp's glow, dimmed as it turns away from the camera; false when it is not drawn. */
  addGlow(g: LampGlow): boolean {
    if (this.glowCount >= GLOW_CAPACITY) return false;
    const dx = this.cam.x - g.x;
    const dy = this.cam.y - g.y;
    const dz = this.cam.z - g.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > GLOW_RANGE) return false;
    let k = 1;
    if (g.fx !== 0 || g.fz !== 0) {
      const h = Math.hypot(dx, dz) || 1;
      const facing = (dx * g.fx + dz * g.fz) / h;
      k = THREE.MathUtils.smoothstep(facing, -0.25, 0.35);
      if (k < 0.01) return false;
    }
    const spec = GLOW[g.kind];
    const i = this.glowCount++;
    this.glowPos.setXYZ(i, g.x, g.y, g.z);
    this.glowColor.setXYZ(i, spec.color[0] * k, spec.color[1] * k, spec.color[2] * k);
    this.glowSize.setX(i, spec.size);
    return true;
  }

  /** Adds a reflector's glow, shining back at `gain` (0..1) of its full strength all round; false when it is not drawn. */
  addReflector(x: number, y: number, z: number, gain: number): boolean {
    if (this.glowCount >= GLOW_CAPACITY || gain < 0.02) return false;
    if (Math.hypot(this.cam.x - x, this.cam.y - y, this.cam.z - z) > GLOW_RANGE) return false;
    const spec = GLOW.reflector;
    const i = this.glowCount++;
    this.glowPos.setXYZ(i, x, y, z);
    this.glowColor.setXYZ(i, spec.color[0] * gain, spec.color[1] * gain, spec.color[2] * gain);
    this.glowSize.setX(i, spec.size);
    return true;
  }

  /**
   * Offers a lit car's headlights (its bumper on the ground, heading, strength 0..1); the nearest to the camera light the
   * ground. The player's own car (`own`) always does, at its strength, in a slot of its own.
   */
  offerPool(x: number, z: number, heading: number, strength: number, own = false): void {
    if (strength <= 0) return;
    if (own) {
      const c = this.own;
      c.x = x;
      c.z = z;
      c.heading = heading;
      c.strength = strength;
      this.hasOwn = true;
      return;
    }
    const d2 = (x - this.cam.x) ** 2 + (z - this.cam.z) ** 2;
    if (d2 > POOL_RANGE * POOL_RANGE) return;
    const list = this.candidates;
    if (list.length > HEADLIGHTS && d2 >= list[list.length - 1]!.d2) return;
    let i = list.length;
    while (i > 0 && list[i - 1]!.d2 > d2) i--;
    const c = this.spare.pop() ?? { x: 0, z: 0, heading: 0, strength: 0, d2: 0 };
    c.x = x;
    c.z = z;
    c.heading = heading;
    c.strength = strength;
    c.d2 = d2;
    list.splice(i, 0, c);
    if (list.length > HEADLIGHTS + 1) this.spare.push(list.pop()!);
  }

  /** Writes the frame's headlights (on `ground`) and, on a wet road, the streaks under the nearest glows. */
  finish(ground: (x: number, z: number) => number): void {
    const glowGeo = this.glows.geometry;
    glowGeo.setDrawRange(0, this.glowCount);
    // An empty update range would upload the whole array (WebGL 2 bufferSubData reads a length of 0 as "to the end").
    if (this.glowCount > 0) for (const a of [this.glowPos, this.glowColor, this.glowSize]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.glowCount * a.itemSize);
      a.needsUpdate = true;
    }
    const list = this.candidates;
    const first = this.hasOwn ? 1 : 0;
    const n = Math.min(list.length, HEADLIGHTS - first);
    const cut = list.length > n ? Math.sqrt(list[n]!.d2) : POOL_RANGE;
    if (this.hasOwn) this.setHeadlight(0, this.own, this.own.strength, ground);
    for (let i = 0; i < n; i++) {
      const c = list[i]!;
      this.setHeadlight(first + i, c, c.strength * THREE.MathUtils.smoothstep(cut - Math.sqrt(c.d2), 0, POOL_FADE), ground);
    }
    const count = first + n;
    this.poolCount = count;
    this.headlights.uHeadCount.value = count;
    if (this.pools) {
      this.pools.count = count;
      if (count > 0) {
        this.pools.instanceMatrix.needsUpdate = true;
        this.pools.instanceColor!.needsUpdate = true;
      }
    }
    this.layStreaks(ground);
  }

  /** Slot `i` of the headlights (and of the software tier's painted pools): car `c` at strength `k`, on `ground`. */
  private setHeadlight(i: number, c: PoolCandidate, k: number, ground: (x: number, z: number) => number): void {
    const end = POOL_START + POOL_LENGTH;
    const fx = Math.sin(c.heading);
    const fz = Math.cos(c.heading);
    const y0 = ground(c.x, c.z);
    // The light follows the slope; past a drop (a ramp's end, the quay) it tips down 1.5 m at most, so the ground far below stays dark.
    const y1 = Math.max(ground(c.x + fx * end, c.z + fz * end), y0 - 1.5);
    const A = this.headlights.uHeadA.value;
    const B = this.headlights.uHeadB.value;
    A[i * 4] = c.x;
    A[i * 4 + 1] = y0;
    A[i * 4 + 2] = c.z;
    A[i * 4 + 3] = k;
    B[i * 4] = fx;
    B[i * 4 + 1] = fz;
    B[i * 4 + 2] = (y1 - y0) / end;
    if (this.pools) {
      this.q.setFromEuler(this.e.set(-Math.atan2(y1 - y0, end), c.heading, 0, 'YXZ'));
      this.m.compose(this.p.set(c.x + fx * POOL_START, y0 + (y1 - y0) * (POOL_START / end) + 0.05, c.z + fz * POOL_START), this.q, this.s.set(POOL_DECAL_WIDTH, 1, POOL_LENGTH));
      this.pools.setMatrixAt(i, this.m);
      this.pools.setColorAt(i, this.c.setRGB(POOL_PAINT[0] * k, POOL_PAINT[1] * k, POOL_PAINT[2] * k));
    }
  }

  /**
   * Offers a fixed light (a street lamp's head) for a wet-road streak this frame: its position and linear colour. The
   * streaks go to the STREAK_CAPACITY lights nearest the camera, these and the vehicle glows together.
   */
  offerStreakLight(x: number, y: number, z: number, r: number, g: number, b: number): void {
    if (this.wet <= STREAK_MIN_WET || this.lightCount >= LIGHT_CAPACITY) return;
    const dx = x - this.cam.x;
    const dz = z - this.cam.z;
    if (dx * dx + dz * dz > STREAK_RANGE * STREAK_RANGE) return;
    const L = this.lights;
    const o = this.lightCount++ * 6;
    L[o] = x;
    L[o + 1] = y;
    L[o + 2] = z;
    L[o + 3] = r;
    L[o + 4] = g;
    L[o + 5] = b;
  }

  /** Keeps candidate `id` at squared distance d2 if it is among the STREAK_CAPACITY nearest so far. */
  private rank(id: number, d2: number, n: number): number {
    const bd = this.bestD;
    const bi = this.bestI;
    if (n >= STREAK_CAPACITY && d2 >= bd[n - 1]!) return n;
    let i = Math.min(n, STREAK_CAPACITY - 1);
    while (i > 0 && bd[i - 1]! > d2) {
      bd[i] = bd[i - 1]!;
      bi[i] = bi[i - 1]!;
      i--;
    }
    bd[i] = d2;
    bi[i] = id;
    return Math.min(n + 1, STREAK_CAPACITY);
  }

  /**
   * Wet-road reflections: a flat streak under each of the nearest lights, centred on the mirror point (h / (h + c) of
   * the way from the light's foot to the camera's, h the light's height and c the camera's) and stretched towards the
   * camera. Their brightness follows the wetness and the water's Fresnel at the mirror point (STREAK_FRESNEL).
   */
  private layStreaks(ground: (x: number, z: number) => number): void {
    const s = this.streaks;
    let n = 0;
    if (this.wet > STREAK_MIN_WET) {
      const pos = this.glowPos.array as Float32Array;
      const cam = this.cam;
      let ranked = 0;
      for (let i = 0; i < this.glowCount; i++) {
        const d2 = (cam.x - pos[i * 3]!) ** 2 + (cam.z - pos[i * 3 + 2]!) ** 2;
        if (d2 <= STREAK_RANGE * STREAK_RANGE) ranked = this.rank(i, d2, ranked);
      }
      const L = this.lights;
      for (let j = 0; j < this.lightCount; j++) ranked = this.rank(GLOW_CAPACITY + j, (cam.x - L[j * 6]!) ** 2 + (cam.z - L[j * 6 + 2]!) ** 2, ranked);
      const col = this.glowColor.array as Float32Array;
      for (let r = 0; r < ranked; r++) {
        const id = this.bestI[r]!;
        const glow = id < GLOW_CAPACITY;
        const src = glow ? pos : L;
        const o = glow ? id * 3 : (id - GLOW_CAPACITY) * 6;
        const x = src[o]!;
        const y = src[o + 1]!;
        const z = src[o + 2]!;
        const dx = cam.x - x;
        const dz = cam.z - z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.5) continue;
        const gy = ground(x, z);
        const h = Math.max(0.05, y - gy);
        const c = Math.max(0.2, cam.y - gy);
        const t = h / (h + c);
        const length = Math.min(12, dist * 0.5, 1 + h * 5);
        const heading = Math.atan2(dx, dz);
        const mx = x + dx * t;
        const mz = z + dz * t;
        this.q.setFromEuler(this.e.set(0, heading, 0, 'YXZ'));
        this.m.compose(this.p.set(mx - (Math.sin(heading) * length) / 2, ground(mx, mz) + 0.04, mz - (Math.cos(heading) * length) / 2), this.q, this.s.set(0.55, 1, length));
        s.setMatrixAt(n, this.m);
        // The camera sees the mirror point (h + c) down over `dist` across, so at that angle off the vertical.
        const fresnel = Math.min(1, waterFresnel((h + c) / Math.hypot(dist, h + c)) / STREAK_FRESNEL);
        // Faded out close to the camera, where the mirror point runs under it and a streak would fill the view.
        const k = this.wet * this.dark * 0.5 * fresnel * THREE.MathUtils.smoothstep(dist, STREAK_NEAR, STREAK_NEAR * 3);
        if (glow) s.setColorAt(n, this.c.setRGB(col[o]! * k, col[o + 1]! * k, col[o + 2]! * k));
        else s.setColorAt(n, this.c.setRGB(L[o + 3]! * k, L[o + 4]! * k, L[o + 5]! * k));
        n++;
      }
    }
    this.lightCount = 0;
    this.streakCount = n;
    s.count = n;
    if (n > 0) {
      s.instanceMatrix.needsUpdate = true;
      s.instanceColor!.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const o of [this.glows, this.streaks, ...(this.pools ? [this.pools] : [])]) {
      o.geometry.dispose();
      o.material.dispose();
    }
    this.pools?.dispose();
    this.streaks.dispose();
    this.haze.dispose();
  }
}

/**
 * Street-lamp haze: a wide, faint glow round every lamp head at night, on top of the lamp's own halo (props.ts), as the
 * air scatters the light. In rain the drops scatter far more: the haze grows by HAZE_RAIN_SIZE and brightens by
 * HAZE_RAIN_GAIN. It shares the lamp halos' position and on/off attributes (a knocked-over lamp's goes dark with its
 * halo), so it is one static batch, one draw call, on every tier. Depth-tested: a lamp behind a building shows none.
 */
export const HAZE_SIZE = 4.2;
export const HAZE_COLOR: Rgb = [0.34, 0.27, 0.17];
export const HAZE_RAIN_SIZE = 1.4;
export const HAZE_RAIN_GAIN = 1.6;
/** The haze never draws larger than this many pixels across (a lamp next to the camera would fill the screen). */
const HAZE_MAX_PX = 420;
const HAZE_PULL = 0.6;

const HAZE_VS = /* glsl */ `
uniform float uPixelsPerMetre;
uniform float uSize;
varying float vOn;
#include <fog_pars_vertex>
void main() {
  vOn = color.r;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_PointSize = vOn > 0.5 ? min( uSize * uPixelsPerMetre / max( 0.05, - mvPosition.z ), ${HAZE_MAX_PX.toFixed(1)} ) : 0.0;
  gl_Position = projectionMatrix * vec4( mvPosition.xyz * max( 0.0, 1.0 - ${HAZE_PULL.toFixed(2)} / length( mvPosition.xyz ) ), 1.0 );
  #include <fog_vertex>
}`;

const HAZE_FS = /* glsl */ `
uniform vec3 uColor;
varying float vOn;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot( c, c );
  if ( r2 >= 1.0 || vOn < 0.5 ) discard;
  float a = exp( - r2 * 4.5 ) * ( 1.0 - r2 );
  ${FOG_FADE}
  gl_FragColor = vec4( uColor * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** The haze's size (m) and brightness (0 by day) at a darkness and rain. */
export function hazeLevel(night: number, rain: number): { size: number; gain: number } {
  const r = Math.max(0, Math.min(1, rain));
  return { size: HAZE_SIZE * (1 + (HAZE_RAIN_SIZE - 1) * r), gain: THREE.MathUtils.smoothstep(night, 0.35, 0.8) * (1 + (HAZE_RAIN_GAIN - 1) * r) };
}

export class LampHaze {
  readonly material: THREE.ShaderMaterial;
  points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  gain = 0;
  size = HAZE_SIZE;

  constructor(private readonly group: THREE.Group) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: HAZE_VS,
      fragmentShader: HAZE_FS,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uPixelsPerMetre: { value: 800 }, uSize: { value: HAZE_SIZE }, uColor: { value: new THREE.Color() } }]),
      vertexColors: true,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.material.name = 'lamp-haze';
  }

  /** Draws round the lamp halos' points (PropsView's 'lampHalos'), sharing their position and on/off colour attributes. */
  attach(halos: THREE.Object3D | undefined): void {
    const src = (halos as THREE.Points | undefined)?.geometry;
    if (!src?.getAttribute('position') || !src.getAttribute('color')) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', src.getAttribute('position'));
    geo.setAttribute('color', src.getAttribute('color'));
    const points = new THREE.Points(geo, this.material);
    points.name = 'lamp-haze';
    points.frustumCulled = false;
    points.renderOrder = 3;
    points.visible = false;
    this.group.add(points);
    this.points = points;
  }

  update(night: number, rain: number, pixelsPerMetre: number): void {
    const { size, gain } = hazeLevel(night, rain);
    this.gain = gain;
    this.size = size;
    const u = this.material.uniforms;
    u.uSize!.value = size;
    u.uPixelsPerMetre!.value = pixelsPerMetre;
    (u.uColor!.value as THREE.Color).setRGB(HAZE_COLOR[0] * gain, HAZE_COLOR[1] * gain, HAZE_COLOR[2] * gain);
    if (this.points) this.points.visible = gain > 0.005;
  }

  dispose(): void {
    // The attributes belong to the lamp halos.
    this.material.dispose();
  }
}
