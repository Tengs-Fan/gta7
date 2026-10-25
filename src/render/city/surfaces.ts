// Ground surface materials for the city: PBR sets from the asset library (asphalt, grass, sand) with procedural
// fallbacks, and a world-space detail patch per surface (repairs, cracks, lane wear, kerb grime, lawn edges, sand
// ripples and the wet band along the shore). Uniforms only at runtime; the software tier keeps the plain procedural
// surfaces. Every ground texture follows the tier's anisotropic filtering (setAnisotropy).

import * as THREE from 'three';
import { registerDebug } from '../../debug';
import { BEACH_W, CURB_H, LANE_W, SAND_DROP, WATER_Y } from '../../world/constants';
import type { StaticWorld } from '../../world/staticWorld';
import { assets } from '../assets';
import { cloudNoiseTexture, groundSurface, type GroundTex } from '../textures';
import { seaDrawnDepth, surfPhases } from '../sea';

export type GroundDetail = 'road' | 'lot' | 'kerb' | 'curb' | 'grass' | 'sand' | 'plain';
export type AnisoTier = 'high' | 'medium' | 'low' | 'software';

/** Anisotropic filtering per tier, capped by the GPU (min(cap, maxAnisotropy)). */
export const ANISOTROPY_CAP: Readonly<Record<AnisoTier, number>> = { high: 16, medium: 8, low: 4, software: 1 };

export function anisotropyFor(tier: AnisoTier, maxAnisotropy: number): number {
  const max = Number.isFinite(maxAnisotropy) && maxAnisotropy >= 1 ? Math.floor(maxAnisotropy) : 1;
  return Math.max(1, Math.min(ANISOTROPY_CAP[tier], max));
}

/** PBR sets in src/assets/textures and the world size (m) of one repeat, with their tint (linear multiplier). */
interface PbrSpec {
  set: string;
  tile: number;
  tint: [number, number, number];
  normalScale: number;
}

/** Tints bring each set's mean albedo to the d98da7b surface colour, so detail rises without changing brightness. */
export const PBR_SURFACES: Readonly<Partial<Record<GroundDetail, PbrSpec>>> = {
  road: { set: 'worn_asphalt', tile: 4, tint: [0.76, 1.12, 1.65], normalScale: 1 },
  lot: { set: 'worn_asphalt', tile: 4, tint: [0.76, 1.12, 1.65], normalScale: 1 },
  grass: { set: 'leafy_grass', tile: 3, tint: [0.52, 1.02, 0.56], normalScale: 1 },
  sand: { set: 'coast_sand_01', tile: 4, tint: [2.3, 2.38, 2.5], normalScale: 0.8 },
};

/** Lawns spill this far (m) onto the paving where they meet a sidewalk; the shader frays the strip. */
export const LAWN_OVERHANG = 0.18;
/** Sand within this distance (m) of the waterline is wet and dark (the shader frays the band's inland edge). */
export const WET_SAND_BAND = 8.8;
/** Wet sand keeps this share less of its albedo, and its roughness falls to WET_SAND_ROUGHNESS (dry sand is rougher). */
export const WET_SAND_DARKEN = 0.62;
export const WET_SAND_ROUGHNESS = 0.65;

const n = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));

const VS_PARS = /* glsl */ `
attribute vec4 aGround;
varying vec4 vGround;
varying vec3 vGroundPos;`;

const VS_MAIN = /* glsl */ `
vGroundPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vGround = aGround;`;

const FS_PARS = /* glsl */ `
uniform sampler2D uGroundNoise;
uniform float uGroundSurf;
varying vec4 vGround;
varying vec3 vGroundPos;
float gN( vec2 p ) { return texture2D( uGroundNoise, p ).r; }
float gHash( vec2 c ) { return fract( sin( dot( c, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
/** Signed distance (m) inside the rectangle vGround (minX, minZ, maxX, maxZ): positive inside, negative outside. */
float gRect( vec2 p ) { return min( min( p.x - vGround.x, vGround.z - p.x ), min( p.y - vGround.y, vGround.w - p.y ) ); }`;

/** Shared head of every albedo chunk: declares what the roughness and normal chunks read later in main(). */
const FS_HEAD = /* glsl */ `
float gRough = 0.0;
float gWetSand = 0.0;
float gFoam = 0.0;
vec2 gp = vGroundPos.xz;
float gpx = max( length( fwidth( gp ) ), 1e-4 );`;

/**
 * A second sample of the albedo, turned and at a scale no whole number away, averaged in: the set's own repeat (its
 * spots and stains) no longer lines up into a visible grid.
 */
const FS_UNTILE = /* glsl */ `
#ifdef USE_MAP
{
  vec2 auv = mat2( 0.8, -0.6, 0.6, 0.8 ) * vMapUv * 1.37 + vec2( 0.31, 0.77 );
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuse * texture2D( map, auv ).rgb, 0.5 );
}
#endif`;

/** Asphalt: macro tone, repair patches with sealed seams, cracks, and on road segments lane wear (vGround: across, from start, to end, half width). */
const FS_ASPHALT = (lanes: boolean) => /* glsl */ `
{
  float macro = gN( gp * 0.0113 ) * 0.6 + gN( gp * 0.0291 + 0.37 ) * 0.4;
  float tone = mix( 0.68, 1.3, smoothstep( 0.25, 0.75, macro ) ) * mix( 0.82, 1.15, gN( gp * 0.137 + 0.61 ) );
  float cn = gN( gp * 0.071 + 0.13 ) * 0.62 + gN( gp * 0.173 + 0.71 ) * 0.38;
  float zone = smoothstep( 0.45, 0.55, gN( gp * 0.0197 + 0.53 ) );
  float cfw = max( fwidth( cn ), 1e-5 );
  float br = gN( gp * 0.093 + 0.29 );
  float oilN = gN( gp * 0.21 + 0.47 );
  // Repairs: about a third of the 9 m cells hold a rectangle of fresher, darker asphalt with a sealed seam.
  vec2 cell = floor( gp / 9.0 );
  if ( gHash( cell ) < 0.3 ) {
    vec2 c = ( cell + 0.5 + ( vec2( gHash( cell + 5.1 ), gHash( cell + 9.3 ) ) - 0.5 ) * 0.35 ) * 9.0;
    vec2 hs = mix( vec2( 0.8, 0.5 ), vec2( 2.8, 1.7 ), vec2( gHash( cell + 2.3 ), gHash( cell + 7.7 ) ) );
    if ( gHash( cell + 3.9 ) > 0.5 ) hs = hs.yx;
    vec2 q = abs( gp - c ) - hs;
    float sd = max( q.x, q.y );
    float aa = gpx * 0.75;
    float inside = 1.0 - smoothstep( - aa, aa, sd );
    float seam = clamp( 0.05 / gpx, 0.0, 1.0 ) * ( 1.0 - smoothstep( 0.025, 0.025 + aa, abs( sd ) ) );
    tone *= mix( 1.0, 0.66, inside ) * ( 1.0 - 0.5 * seam );
    gRough -= 0.08 * inside;
  }
  // Cracks: thin meanders along an iso-line of two incommensurate noise samples, in worn zones, faded out once thinner than a pixel.
  float wpx = 0.02 / gpx;
  float dpx = abs( cn - 0.5 ) / cfw;
  float crack = zone * min( wpx, 1.0 ) * ( 1.0 - smoothstep( 0.5 * max( wpx, 1.0 ), 0.5 * max( wpx, 1.0 ) + 1.0, dpx ) ) * ( 1.0 - smoothstep( 0.015, 0.04, gpx ) );
  tone *= 1.0 - 0.7 * crack;
${lanes ? `  if ( vGround.w > 0.5 ) {
    // Lane wear: polished wheel paths either side of each lane's centre, and a dark oil strip mid-lane, heaviest near the junctions.
    float a = abs( vGround.x );
    float lanes = vGround.w > 6.5 ? 2.0 : 1.0;
    float k = min( floor( a / ${n(LANE_W)} ), lanes - 1.0 );
    float off = a - ${n(LANE_W)} * ( k + 0.5 );
    float track = exp( - pow( ( abs( off ) - 0.85 ) / 0.3, 2.0 ) ) * smoothstep( 0.3, 0.7, br + 0.25 );
    float nearJ = 1.0 - smoothstep( 6.0, 30.0, min( vGround.y, vGround.z ) );
    float oil = exp( - pow( off / 0.38, 2.0 ) ) * ( 0.35 + 0.65 * nearJ ) * smoothstep( 0.35, 0.65, oilN );
    tone *= ( 1.0 + 0.12 * track ) * ( 1.0 - 0.32 * oil );
    gRough -= 0.1 * track + 0.14 * oil;
  }` : ''}
  diffuseColor.rgb *= tone;
}`;

/** Sidewalks: grime gathered along the kerb edge of the rectangle vGround (its sides are the kerbs), and faint stains. */
const FS_KERB = /* glsl */ `
{
  float d = abs( gRect( gp ) );
  float nk = gN( gp * 0.31 + 0.11 ) * 0.6 + gN( gp * 1.13 + 0.57 ) * 0.4;
  float grime = clamp( ( 1.0 - smoothstep( 0.1, 0.42 + 0.3 * nk, d ) ) * ( 0.75 + 0.5 * nk ), 0.0, 1.0 );
  float macro = gN( gp * 0.043 + 0.77 );
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.5, 0.46, 0.4 ), grime ) * mix( 0.94, 1.05, macro );
}`;

/** Kerb faces and gutters: road dirt, heaviest at the foot of the kerb. */
const FS_CURB = /* glsl */ `
{
  float nc = gN( gp * 0.47 + vGroundPos.y * 1.7 ) * 0.6 + gN( gp * 1.9 + 0.2 ) * 0.4;
  float low = 1.0 - smoothstep( 0.0, 0.15, vGroundPos.y );
  float grime = clamp( 0.3 + 0.45 * low + 0.6 * ( nc - 0.5 ), 0.0, 1.0 );
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.55, 0.52, 0.47 ), grime );
}`;

/** Lawns: dry and lush patches, and where a lawn meets a sidewalk (the rectangle vGround) a soil band and a frayed overhang. */
const FS_GRASS = /* glsl */ `
{
  float m1 = gN( gp * 0.061 + 0.21 );
  float m2 = gN( gp * 0.19 + 0.66 );
  float clover = smoothstep( 0.52, 0.68, gN( gp * 0.93 + 0.27 ) );
  diffuseColor.rgb *= mix( vec3( 0.86, 1.04, 0.86 ), vec3( 1.22, 1.06, 0.7 ), smoothstep( 0.4, 0.78, m1 ) ) * mix( 0.58, 1.38, m2 ) * mix( vec3( 1.0 ), vec3( 0.6, 0.78, 0.55 ), clover );
  float f = gRect( gp );
  float ne = gN( gp * 1.9 + 0.4 ) * 0.65 + gN( gp * 4.3 + 0.8 ) * 0.35;
  if ( f < - ${n(LAWN_OVERHANG)} * smoothstep( 0.3, 0.7, ne ) ) discard;
  float ns = gN( gp * 0.83 + 0.15 );
  float soil = ( 1.0 - smoothstep( 0.0, 0.06 + 0.32 * ns, f ) ) * step( 0.0, f ) * 0.8;
  diffuseColor.rgb = mix( diffuseColor.rgb * mix( 1.0, 0.72, step( f, 0.0 ) ), vec3( 0.16, 0.115, 0.075 ), soil );
}`;

/** Sand: colour variation, a wet band from the waterline inland with a frayed edge, and the surf's lace running up and back. */
const FS_SAND = /* glsl */ `
{
  float inland = ( vGroundPos.y - ( ${n(WATER_Y)} ) ) * ${n(BEACH_W / SAND_DROP)};
  float m1 = gN( gp * 0.037 + 0.15 );
  float m2 = gN( gp * 0.13 + 0.45 );
  float edgeN = gN( vec2( gp.y * 0.021, 0.61 ) ) * 0.7 + gN( gp * 0.27 + 0.33 ) * 0.3;
  // Bubbles of 10-50 cm (the noise tile holds 16 cells): finer ones alias into a knitted pattern from a few metres up.
  float lace = gN( mat2( 0.92, - 0.39, 0.39, 0.92 ) * gp * vec2( 0.29, 0.13 ) + vec2( 0.0, 0.31 ) ) * 0.6 + gN( gp * 0.61 + 0.53 ) * 0.4;
  float laceFade = 1.0 - smoothstep( 0.03, 0.09, gpx );
  diffuseColor.rgb *= mix( 0.9, 1.08, m1 ) * mix( vec3( 0.97, 0.98, 1.02 ), vec3( 1.04, 1.01, 0.95 ), m2 );
  float edge = ${n(WET_SAND_BAND)} + 2.6 * edgeN;
  gWetSand = 1.0 - smoothstep( edge, edge + 2.6, inland );
  // The swash's reach runs up and back with the surf, scalloped along the shore (cusps of a few metres).
  float cusp = gN( vec2( gp.y * 0.021, 0.71 ) ) * 0.7 + gN( vec2( gp.y * 0.067, 0.29 ) ) * 0.3;
  float reach = 0.4 + 1.3 * ( 0.5 + 0.5 * sin( uGroundSurf + gp.y * 0.043 ) ) + 1.2 * ( cusp - 0.5 );
  // The swash's edge breaks into irregular runs (gaps of a few metres and of half a metre), fainter further off.
  float rimGaps = gN( vec2( gp.y * 0.031, 0.47 ) ) * 0.6 + gN( vec2( gp.y * 0.13, 0.83 ) ) * 0.4;
  float rim = ( 1.0 - smoothstep( 0.0, 0.3, abs( inland - reach ) ) ) * smoothstep( 0.4, 0.62, rimGaps ) * mix( 0.45, 1.0, laceFade );
  float behind = ( 1.0 - smoothstep( 0.0, max( reach, 0.2 ), inland ) ) * 0.4;
  float bubbles = mix( 0.5, smoothstep( 0.38, 0.68, lace ), laceFade );
  gFoam = clamp( ( rim * 0.85 + behind ) * bubbles, 0.0, 1.0 ) * step( - 0.2, inland );
  diffuseColor.rgb *= 1.0 - ${n(WET_SAND_DARKEN)} * gWetSand;
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.78, 0.8, 0.8 ), gFoam );
}`;

const FS_PLAIN = /* glsl */ `
{
  diffuseColor.rgb *= mix( 0.92, 1.06, gN( gp * 0.05 + 0.3 ) ) * mix( 0.96, 1.03, gN( gp * 0.21 + 0.8 ) );
}`;

const FS_ROUGH_ALL = /* glsl */ `
roughnessFactor = clamp( roughnessFactor + gRough, 0.04, 1.0 );`;

const FS_ROUGH_SAND = /* glsl */ `
roughnessFactor = mix( roughnessFactor, ${n(WET_SAND_ROUGHNESS)}, gWetSand );
roughnessFactor = mix( roughnessFactor, 0.75, gFoam );`;

/** Wind ripples on dry sand: a warped crest train whose slope tilts the normal, faded where it would alias and on wet sand. */
const FS_NORMAL_SAND = /* glsl */ `
{
  vec2 rw = vec2( gN( gp * 0.019 + 0.1 ), gN( gp * 0.019 + 0.6 ) ) - 0.5;
  float field = smoothstep( 0.3, 0.6, gN( gp * 0.029 + 0.42 ) );
  vec2 rdir = vec2( 0.929, 0.37 );
  float ph = ${n((2 * Math.PI) / 0.46)} * dot( gp + rw * 2.2, rdir ) + gN( gp * 0.11 + 0.3 ) * 2.5;
  float fade = ( 1.0 - smoothstep( 0.035, 0.1, gpx ) ) * ( 0.35 + 0.65 * field ) * ( 1.0 - 0.8 * gWetSand );
  float s = ( cos( ph ) + 0.5 * cos( 2.0 * ph + 1.2 ) ) * 0.22 * fade;
  normal = normalize( normal + mat3( viewMatrix ) * vec3( - rdir.x * s, 0.0, - rdir.y * s ) );
}`;

const ALBEDO: Record<GroundDetail, string> = {
  road: FS_ASPHALT(true),
  lot: FS_ASPHALT(false),
  kerb: FS_KERB,
  curb: FS_CURB,
  grass: FS_GRASS,
  sand: FS_SAND,
  plain: FS_PLAIN,
};

/** Fallback procedural tile per surface, and its metres per repeat (as at d98da7b). */
const FALLBACK: Record<GroundDetail, { tex: GroundTex; tile: number }> = {
  road: { tex: 'asphalt', tile: 8 },
  lot: { tex: 'asphalt', tile: 8 },
  kerb: { tex: 'sidewalk', tile: 4 },
  curb: { tex: 'concrete', tile: 2 },
  grass: { tex: 'grass', tile: 8 },
  sand: { tex: 'sand', tile: 8 },
  plain: { tex: 'plaza', tile: 6 },
};

export interface GroundUniforms {
  uGroundNoise: { value: THREE.Texture };
  uGroundSurf: { value: number };
}

export class GroundSurfaces {
  readonly uniforms: GroundUniforms;
  /** Every texture the ground materials sample (anisotropy follows the tier). */
  readonly textures = new Set<THREE.Texture>();
  readonly materials: THREE.MeshStandardMaterial[] = [];
  /** Service covers and junction tyre marks as the road builder placed them (tests, debug hook). */
  readonly manholes: Array<{ x: number; z: number; segment: number }> = [];
  readonly tyreMarks: Array<{ node: number; points: Array<{ x: number; z: number }> }> = [];
  private anisotropy = 0;

  constructor(readonly software: boolean) {
    this.uniforms = { uGroundNoise: { value: cloudNoiseTexture() }, uGroundSurf: { value: 0 } };
  }

  /** The PBR set of a surface when it loaded (never on the software tier). */
  pbr(detail: GroundDetail): { map: THREE.Texture; normal: THREE.Texture; orm: THREE.Texture; spec: PbrSpec } | null {
    const spec = PBR_SURFACES[detail];
    if (!spec || this.software) return null;
    const map = assets.texture(`tex.${spec.set}.albedo`);
    const normal = assets.texture(`tex.${spec.set}.normal`);
    const orm = assets.texture(`tex.${spec.set}.orm`);
    return map && normal && orm ? { map, normal, orm, spec } : null;
  }

  /** Metres per texture repeat for a surface's UVs. */
  tile(detail: GroundDetail): number {
    return this.pbr(detail)?.spec.tile ?? FALLBACK[detail].tile;
  }

  /**
   * The material of a ground surface: the PBR set when loaded (else the procedural tile with `tex`), with the detail
   * patch on hardware tiers. Call after any wet-ground patch so the wet look applies on top of the detail.
   */
  material(detail: GroundDetail, tex: GroundTex = FALLBACK[detail].tex, seed = 1): THREE.MeshStandardMaterial {
    const set = this.pbr(detail);
    let mat: THREE.MeshStandardMaterial;
    if (set) {
      mat = new THREE.MeshStandardMaterial({
        map: set.map,
        normalMap: set.normal,
        normalScale: new THREE.Vector2(set.spec.normalScale, set.spec.normalScale),
        roughnessMap: set.orm,
        aoMap: set.orm,
        aoMapIntensity: 0.6,
        roughness: 1,
        metalness: 0,
      });
      mat.color.setRGB(...set.spec.tint);
    } else {
      const s = groundSurface(tex, seed);
      mat = new THREE.MeshStandardMaterial({ map: s.map, roughnessMap: s.rough, normalMap: s.normal, normalScale: new THREE.Vector2(0.55, 0.55), roughness: 1, metalness: 0 });
    }
    mat.name = `ground-${detail}`;
    for (const t of [mat.map, mat.normalMap, mat.roughnessMap, mat.aoMap]) if (t) this.textures.add(t);
    this.materials.push(mat);
    return mat;
  }

  /** Adds the surface's detail patch (no-op on the software tier). Chains any patch already on the material. */
  patch(mat: THREE.MeshStandardMaterial, detail: GroundDetail): THREE.MeshStandardMaterial {
    if (this.software) return mat;
    const prior = mat.onBeforeCompile;
    const priorKey = Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey') ? mat.customProgramCacheKey.bind(mat) : null;
    const uniforms = this.uniforms;
    // The sand's spots and stains repeat visibly; the asphalt's and grass's fine grain does not (and keeps its contrast).
    const untile = detail === 'sand' && this.pbr(detail) !== null;
    mat.onBeforeCompile = (shader, renderer) => {
      prior.call(mat, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>${VS_PARS}`)
        .replace('#include <project_vertex>', `#include <project_vertex>${VS_MAIN}`);
      let fs = shader.fragmentShader
        .replace('#include <common>', `#include <common>${FS_PARS}`)
        .replace('#include <map_fragment>', `#include <map_fragment>${FS_HEAD}${untile ? FS_UNTILE : ''}${ALBEDO[detail]}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>${FS_ROUGH_ALL}${detail === 'sand' ? FS_ROUGH_SAND : ''}`);
      if (detail === 'sand') fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>${FS_NORMAL_SAND}`);
      shader.fragmentShader = fs;
    };
    mat.customProgramCacheKey = () => `${priorKey ? priorKey() : ''}|gta7-ground-${detail}`;
    return mat;
  }

  /** Sets every ground texture's anisotropic filtering for a tier; textures re-upload once when it changes (no program changes). */
  setAnisotropy(tier: AnisoTier, maxAnisotropy: number): number {
    const a = anisotropyFor(tier, maxAnisotropy);
    if (a === this.anisotropy) return a;
    this.anisotropy = a;
    for (const t of this.textures) {
      if (t.anisotropy === a) continue;
      t.anisotropy = a;
      t.needsUpdate = true;
    }
    return a;
  }

  get currentAnisotropy(): number {
    return this.anisotropy;
  }

  /** Per frame: the surf phase (as the sea's), for the lace on the sand. */
  update(time: number): void {
    this.uniforms.uGroundSurf.value = surfPhases(time).surf;
  }

  /** Estimated GPU bytes of the ground textures (w x h x 4 x 1.33 for the mip chain). */
  textureBytes(): number {
    let sum = 0;
    for (const t of this.textures) {
      const img = t.image as { width?: number; height?: number } | undefined;
      sum += (img?.width ?? 0) * (img?.height ?? 0) * 4 * 1.33;
    }
    return sum;
  }

  dispose(): void {
    this.uniforms.uGroundNoise.value.dispose();
  }
}

/** The per-vertex detail attribute (vec4) for a geometry built from ranges of vertices; `fill` gives the value at a vertex. */
export interface GroundRange {
  start: number;
  end: number;
  fill: (x: number, y: number, z: number, out: number[]) => void;
}

/** A rectangle so far out that no point is near its edges (vertices outside every range). */
export const NO_RECT: readonly [number, number, number, number] = [-1e5, -1e5, 1e5, 1e5];

export function setGroundAttribute(geo: THREE.BufferGeometry, ranges: readonly GroundRange[], fallback: readonly number[] = [0, 0, 0, 0]): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const values = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) values.set(fallback, i * 4);
  const tmp = [0, 0, 0, 0];
  for (const r of ranges) {
    for (let i = r.start; i < r.end; i++) {
      r.fill(pos.getX(i), pos.getY(i), pos.getZ(i), tmp);
      values.set(tmp, i * 4);
    }
  }
  geo.setAttribute('aGround', new THREE.BufferAttribute(values, 4));
  return geo;
}

/** A range whose vertices all carry the rectangle `rect`. */
export function rectRange(start: number, end: number, rect: readonly [number, number, number, number]): GroundRange {
  return { start, end, fill: (_x, _y, _z, out) => { out[0] = rect[0]; out[1] = rect[1]; out[2] = rect[2]; out[3] = rect[3]; } };
}

/** Read-outs for validators: `__gta7.ext.ground`. */
export function registerGroundDebug(view: { world: StaticWorld; ground: GroundSurfaces }): void {
  const g = view.ground;
  const b = view.world.layout.bounds;
  registerDebug('ground', {
    /** Anisotropy, every ground texture with its size and filtering, their GPU estimate, and the decal counts. */
    info: () => ({
      anisotropy: g.currentAnisotropy,
      software: g.software,
      pbr: Object.fromEntries((Object.keys(PBR_SURFACES) as GroundDetail[]).map((k) => [k, g.pbr(k) !== null])),
      textures: [...g.textures].map((t) => {
        const img = t.image as { width?: number; height?: number } | undefined;
        return { name: t.name, anisotropy: t.anisotropy, width: img?.width ?? 0, height: img?.height ?? 0 };
      }),
      textureMB: g.textureBytes() / 1e6,
      manholes: g.manholes.length,
      tyreMarks: g.tyreMarks.length,
      roadCentreline: view.world.roads.segments.reduce((sum, s) => sum + (s.vertical ? s.maxZ - s.minZ : s.maxX - s.minX), 0),
    }),
    manholes: () => g.manholes.map((m) => ({ ...m })),
    tyreMarks: () => g.tyreMarks.map((m) => ({ node: m.node, points: m.points.map((p) => ({ ...p })) })),
    /** The sim's water depth at (x, z) and the depth the sea is drawn with (the render-only shelf offshore). */
    seaDepth: (x: number, z: number) => ({ sim: view.world.waterDepth(x, z), drawn: seaDrawnDepth(b, x, z) }),
    /** The beach's waterline (waterDepth 0 contour) and the wet sand band's inland reach (frayed up to +2.6 m). */
    shore: () => ({ waterlineX: b.beachStartX + (BEACH_W * (CURB_H - WATER_Y)) / SAND_DROP, wetBand: WET_SAND_BAND, landMinZ: b.landMinZ, landMaxZ: b.landMaxZ }),
  });
}
