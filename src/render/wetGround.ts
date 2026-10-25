// Wet ground: one shader patch, shared by the road, pavement and plaza materials, that darkens them and makes them
// glossy as the sim's wetness rises. In 'full' mode (High, Medium) puddles gather where a world-space noise exceeds
// a threshold that falls as the ground gets wetter, rain rings ripple in them, and cells under a roof (the rain cover
// map) stay dry; 'simple' mode (Low, software) only darkens and smooths. Everything is driven by uniforms, so weather
// and tier changes never rebuild a program. On a software rasteriser the Lambert stand-ins run the same patch, where
// only the darkening has anything to act on.

import * as THREE from 'three';
import { COVER_NONE } from './rainCover';
import { CLOUD_NOISE_SIZE, cloudNoiseTexture } from './textures';

export type WetMode = 'full' | 'simple';

/** How much albedo full wetness takes off, and a puddle more on top. */
export const WET_DARKEN = 0.35;
const PUDDLE_DARKEN = 0.2;
/** Roughness at full wetness, and in a puddle. */
export const WET_ROUGHNESS = 0.12;
const PUDDLE_ROUGHNESS = 0.03;
/** Puddles fade in over the first 1 / PUDDLE_FADE_IN of wetness. */
const PUDDLE_FADE_IN = 8;
/** A roof this far above the ground keeps it dry. */
const COVER_CLEARANCE = 0.3;
/** World-space scales and offset of the two puddle-noise samples, and their weights. */
const PUDDLE_UV_A = 0.045;
const PUDDLE_UV_B = 0.13;
const PUDDLE_UV_B_OFFSET = 0.37;

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** CPU mirror of the full-mode shader: ground wetness at height y under a roof at `roof` (COVER_NONE when open). */
export function coverWetness(wet: number, roof: number, y: number): number {
  return roof > y + COVER_CLEARANCE ? 0 : wet;
}

/** CPU mirror of the shader's puddle mask for cover-adjusted wetness wetK and puddle noise n. */
export function puddleMask(wetK: number, n: number): number {
  const th = 0.8 + (0.6 - 0.8) * smoothstep(0.35, 1, wetK);
  return smoothstep(th, th + 0.05, n) * Math.min(1, wetK * PUDDLE_FADE_IN);
}

/** CPU mirror of the gain the shader puts on the rain rings' slope (zero outside puddles or when dry above). */
export function rippleGain(puddle: number, rain: number): number {
  return puddle > 0 && rain > 0.01 ? 0.6 * puddle * rain : 0;
}

/** CPU mirror of the shader's puddle noise at (x, z), sampled bilinearly from the base level of cloudNoiseData(). */
export function puddleNoise(data: Uint8Array, x: number, z: number): number {
  const S = CLOUD_NOISE_SIZE;
  const tex = (u: number, v: number) => {
    const tx = u * S - 0.5;
    const ty = v * S - 0.5;
    const x0 = Math.floor(tx);
    const y0 = Math.floor(ty);
    const fx = tx - x0;
    const fy = ty - y0;
    const at = (i: number, j: number) => data[(((j % S) + S) % S) * S + (((i % S) + S) % S)]! / 255;
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bot * fy;
  };
  return tex(x * PUDDLE_UV_A, z * PUDDLE_UV_A) * 0.65 + tex(x * PUDDLE_UV_B + PUDDLE_UV_B_OFFSET, z * PUDDLE_UV_B + PUDDLE_UV_B_OFFSET) * 0.35;
}

const VS_PARS = /* glsl */ `
varying vec3 vWetPos;`;

const VS_MAIN = /* glsl */ `
vWetPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`;

const FS_PARS = /* glsl */ `
uniform float uWet;
uniform float uRainNow;
uniform float uWetTime;
uniform float uWetMode;
uniform sampler2D uPuddleTex;
uniform sampler2D uCover;
uniform vec4 uCoverRect;
varying vec3 vWetPos;
vec2 wetHash( vec2 c ) {
  return fract( sin( vec2( dot( c, vec2( 127.1, 311.7 ) ), dot( c, vec2( 269.5, 183.3 ) ) ) ) * 43758.5453 );
}`;

/** After map_fragment: the wetness here, the puddle mask, the ripple slope, and the darkened albedo. */
const FS_ALBEDO = /* glsl */ `
float wetK = 0.0;
float wetPuddle = 0.0;
vec2 wetRipple = vec2( 0.0 );
if ( uWet > 0.001 ) {
  wetK = uWet;
  if ( uWetMode > 0.5 ) {
    float roof = texture2D( uCover, ( vWetPos.xz - uCoverRect.xy ) * uCoverRect.zw ).r;
    if ( roof > vWetPos.y + ${COVER_CLEARANCE.toFixed(1)} ) wetK = 0.0;
    float n = texture2D( uPuddleTex, vWetPos.xz * ${PUDDLE_UV_A} ).r * 0.65 + texture2D( uPuddleTex, vWetPos.xz * ${PUDDLE_UV_B} + ${PUDDLE_UV_B_OFFSET} ).r * 0.35;
    float th = mix( 0.8, 0.6, smoothstep( 0.35, 1.0, wetK ) );
    // Scaled by the cover-adjusted wetness: dry ground under a roof gets no puddle, however high the noise.
    wetPuddle = smoothstep( th, th + 0.05, n ) * min( 1.0, wetK * ${PUDDLE_FADE_IN.toFixed(1)} );
    if ( wetPuddle > 0.0 && uRainNow > 0.01 ) {
      // Rain rings: one per 0.6 m cell in each of two offset grids, each expanding and fading on its own phase.
      for ( int k = 0; k < 2; k++ ) {
        vec2 q = vWetPos.xz / 0.6 + float( k ) * vec2( 0.5, 0.31 );
        vec2 cell = floor( q );
        vec2 h = wetHash( cell + float( k ) * 17.0 );
        float ph = fract( uWetTime * 1.3 + h.x );
        vec2 dv = fract( q ) - 0.5 - ( h - 0.5 ) * 0.4;
        float dd = length( dv );
        float x = ( dd - ph * 0.3 ) / 0.035;
        wetRipple += dv / max( dd, 0.001 ) * ( - x * exp( - x * x ) ) * ( 1.0 - ph );
      }
      wetRipple *= 0.6 * wetPuddle * uRainNow;
    }
  }
  diffuseColor.rgb *= 1.0 - ${WET_DARKEN} * wetK - ${PUDDLE_DARKEN} * wetPuddle;
}`;

const FS_ROUGHNESS = /* glsl */ `
roughnessFactor = mix( roughnessFactor, ${WET_ROUGHNESS}, wetK );
roughnessFactor = mix( roughnessFactor, ${PUDDLE_ROUGHNESS}, wetPuddle );`;

/** Water filling the surface's pores flattens WET_FLATTEN of its relief (no glitter off the normal map at roughness 0.12). */
export const WET_FLATTEN = 0.8;

/** In a puddle the water's surface is flat (the texture's relief is under it) but for the ripples. */
const FS_NORMAL = /* glsl */ `
normal = normalize( mix( normal, nonPerturbedNormal, ${WET_FLATTEN} * wetK ) );
if ( wetPuddle > 0.0 ) {
  vec3 wetN = normalize( ( viewMatrix * vec4( normalize( vec3( wetRipple.x, 1.0, wetRipple.y ) ), 0.0 ) ).xyz );
  normal = normalize( mix( normal, wetN, wetPuddle ) );
}`;

export interface WetUniforms {
  uWet: { value: number };
  uRainNow: { value: number };
  uWetTime: { value: number };
  uWetMode: { value: number };
  uPuddleTex: { value: THREE.Texture };
  uCover: { value: THREE.Texture };
  uCoverRect: { value: THREE.Vector4 };
}

export class WetGround {
  readonly uniforms: WetUniforms;
  readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly noCover: THREE.DataTexture;

  constructor() {
    this.noCover = new THREE.DataTexture(new Float32Array([COVER_NONE]), 1, 1, THREE.RedFormat, THREE.FloatType);
    this.noCover.needsUpdate = true;
    this.uniforms = {
      uWet: { value: 0 },
      uRainNow: { value: 0 },
      uWetTime: { value: 0 },
      uWetMode: { value: 1 },
      uPuddleTex: { value: cloudNoiseTexture() },
      uCover: { value: this.noCover },
      uCoverRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    };
  }

  /** Adds the patch to a ground material (before it is first drawn). */
  patch(mat: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    const uniforms = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>${VS_PARS}`)
        .replace('#include <project_vertex>', `#include <project_vertex>${VS_MAIN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>${FS_PARS}`)
        .replace('#include <map_fragment>', `#include <map_fragment>${FS_ALBEDO}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>${FS_ROUGHNESS}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>${FS_NORMAL}`);
    };
    mat.customProgramCacheKey = () => 'gta7-wet-ground';
    this.materials.push(mat);
    return mat;
  }

  setCover(texture: THREE.Texture, rect: THREE.Vector4): void {
    this.uniforms.uCover.value = texture;
    this.uniforms.uCoverRect.value.copy(rect);
  }

  /** 'full': puddles, ripples and dry cover (High, Medium); 'simple': darkening and gloss only (Low, software). */
  setMode(mode: WetMode): void {
    this.uniforms.uWetMode.value = mode === 'full' ? 1 : 0;
  }

  get mode(): WetMode {
    return this.uniforms.uWetMode.value > 0.5 ? 'full' : 'simple';
  }

  /** Ground wetness and rain intensity 0..1 (sim weather), and the render time in seconds (ripples). */
  update(wet: number, rain: number, time: number): void {
    this.uniforms.uWet.value = Math.max(0, Math.min(1, wet));
    this.uniforms.uRainNow.value = Math.max(0, Math.min(1, rain));
    // Wrapped so the ripple phase keeps its float precision; 3600 s x 1.3 rings/s is whole, so the wrap is seamless.
    this.uniforms.uWetTime.value = time % 3600;
  }

  dispose(): void {
    this.uniforms.uPuddleTex.value.dispose();
    this.noCover.dispose();
  }
}
