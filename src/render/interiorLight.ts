// Darker garage interiors. Under a garage's roof the sky's light (the hemisphere fill and the image-based light) and the
// sun's are cut to a share, so the shell no longer reads as lit like outdoors; lamps, headlights and any light inside
// keep their strength. One patch of three's lighting chunks, installed before the first program is built, so every lit
// built-in material (and any material an asset brings) gets it with no change of its own and no new program. It works
// from the fragment's world position, so a car or person crossing the door fades smoothly between the two.
//
// The same patch darkens the sky's light at the foot of walls (ambient occlusion in the corner between a wall and the
// ground): a field of signed distances to the buildings' and garage walls' footprints, sampled by world position, so the
// ground next to a wall and the wall's lowest metre lose part of the sky's light on every hardware tier, whatever
// draws them. Sunlight, lamps and headlights are untouched.
//
// Tiers: High, Medium and Low (hardware). The software tier's vertex-lit stand-ins replace these chunks (no darkening).

import * as THREE from 'three';
import { CURB_H } from '../world/constants';
import type { CityLayout, Garage, Rect } from '../world/layout';

/**
 * Garages the shader can hold (the city has four). Each has its own vec4/vec2 uniforms rather than one array: three
 * re-sends array uniforms on every material switch, while single vectors are compared with its cache first.
 */
export const MAX_INTERIORS = 4;
/**
 * Share of the sky's diffuse light (hemisphere and image-based) kept deep inside, of the sun's, and of the sky's
 * reflections: glossy paint inside still mirrors the bright doorway, so reflections lose less.
 */
export const INTERIOR_SKY = 0.5;
export const INTERIOR_SUN = 0.2;
export const INTERIOR_REFLECT = 0.85;
/** Fade across the open door, in metres from the door line: none from DOOR_OUT outside, full from DOOR_IN inside. */
export const DOOR_OUT = 0.6;
export const DOOR_IN = 0.8;
/** Across a closed wall: none on its outer face, full from WALL_IN in (walls are 0.5 m thick). */
export const WALL_IN = 0.3;
const WALL_OUT = 0.02;

/**
 * Ambient occlusion at the foot of walls: the share of the sky's diffuse light lost in the corner itself, falling off
 * as exp(-distance / WALL_AO_REACH) away from the wall and up it (above the kerb height). Reflections lose
 * WALL_AO_SPEC of that.
 */
export const WALL_AO = 0.42;
export const WALL_AO_REACH = 0.55;
export const WALL_AO_SPEC = 0.5;
/** The distance field: texels of FIELD_TEXEL m holding signed distances clamped to FIELD_MIN..FIELD_MAX m (negative inside). */
export const FIELD_TEXEL = 0.5;
const FIELD_MIN = -2;
const FIELD_MAX = 4;

/** Signed distances to the walls' footprints on a square grid (R8, row 0 at minZ), and where it lies. */
export interface WallField {
  data: Uint8Array;
  size: number;
  minX: number;
  minZ: number;
  extent: number;
}

const encode = (d: number): number => Math.round(((Math.min(FIELD_MAX, Math.max(FIELD_MIN, d)) - FIELD_MIN) / (FIELD_MAX - FIELD_MIN)) * 255);

/** The field for a set of footprints: every texel within FIELD_MAX of a footprint gets its signed distance to the nearest. */
export function wallField(rects: readonly Rect[], minX: number, minZ: number, extent: number): WallField {
  const size = Math.round(extent / FIELD_TEXEL);
  const best = new Float32Array(size * size).fill(FIELD_MAX);
  for (const r of rects) {
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    const hx = (r.maxX - r.minX) / 2;
    const hz = (r.maxZ - r.minZ) / 2;
    const i0 = Math.max(0, Math.floor((r.minX - FIELD_MAX - minX) / FIELD_TEXEL));
    const i1 = Math.min(size - 1, Math.ceil((r.maxX + FIELD_MAX - minX) / FIELD_TEXEL));
    const j0 = Math.max(0, Math.floor((r.minZ - FIELD_MAX - minZ) / FIELD_TEXEL));
    const j1 = Math.min(size - 1, Math.ceil((r.maxZ + FIELD_MAX - minZ) / FIELD_TEXEL));
    for (let j = j0; j <= j1; j++) {
      // Texel centres, as linear filtering samples them.
      const qz = Math.abs(minZ + (j + 0.5) * FIELD_TEXEL - cz) - hz;
      for (let i = i0; i <= i1; i++) {
        const qx = Math.abs(minX + (i + 0.5) * FIELD_TEXEL - cx) - hx;
        const d = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
        const o = j * size + i;
        if (d < best[o]!) best[o] = d;
      }
    }
  }
  const data = new Uint8Array(size * size);
  for (let o = 0; o < data.length; o++) data[o] = encode(best[o]!);
  return { data, size, minX, minZ, extent: size * FIELD_TEXEL };
}

/** The field of a city: its buildings' footprints and its garages' walls, over the land. */
export function wallFieldOf(layout: Pick<CityLayout, 'buildings' | 'garages' | 'bounds'>): WallField {
  const b = layout.bounds;
  const half = Math.ceil(Math.max(-b.cityMinX, b.cityMaxX, -b.cityMinZ, b.cityMaxZ) + FIELD_MAX + 4);
  return wallField([...layout.buildings.map((x) => x.rect), ...layout.garages.flatMap((g) => g.walls)], -half, -half, 2 * half);
}

/** The field's signed distance at a point, filtered as the GPU filters it (bilinear between texel centres). */
export function wallDistance(f: WallField, x: number, z: number): number {
  const u = (x - f.minX) / FIELD_TEXEL - 0.5;
  const v = (z - f.minZ) / FIELD_TEXEL - 0.5;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const at = (a: number, b: number): number => f.data[Math.min(f.size - 1, Math.max(0, b)) * f.size + Math.min(f.size - 1, Math.max(0, a))]! / 255;
  const tu = u - i;
  const tv = v - j;
  const e = (at(i, j) * (1 - tu) + at(i + 1, j) * tu) * (1 - tv) + (at(i, j + 1) * (1 - tu) + at(i + 1, j + 1) * tu) * tv;
  return FIELD_MIN + e * (FIELD_MAX - FIELD_MIN);
}

/** 0..1: the sky's light kept at a point by the wall occlusion (the shader's mirror; 1 away from walls). */
export function wallOcclusion(f: WallField, x: number, y: number, z: number): number {
  const d = wallDistance(f, x, z);
  return 1 - WALL_AO * Math.exp(-Math.max(d, 0) / WALL_AO_REACH) * Math.exp(-Math.max(y - CURB_H, 0) / WALL_AO_REACH);
}

/** One interior: its footprint, which edge is open, its floor and its ceiling (the roof's underside). */
export interface Interior {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** The open side: 'N' is minZ, 'S' maxZ, 'E' maxX, 'W' minX (layout.ts garageWalls). */
  door: 'N' | 'S' | 'E' | 'W';
  floor: number;
  ceiling: number;
}

export function interiorsOf(garages: readonly Garage[], ground: (x: number, z: number) => number): Interior[] {
  return garages.slice(0, MAX_INTERIORS).map((g) => {
    const floor = ground((g.rect.minX + g.rect.maxX) / 2, (g.rect.minZ + g.rect.maxZ) / 2);
    return { minX: g.rect.minX, minZ: g.rect.minZ, maxX: g.rect.maxX, maxZ: g.rect.maxZ, door: g.side, floor, ceiling: floor + g.height };
  });
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 0..1: how far inside an interior a point is (the shader's mirror). */
export function insideness(list: readonly Interior[], x: number, y: number, z: number): number {
  let k = 0;
  for (const r of list) {
    const d = { W: x - r.minX, N: z - r.minZ, E: r.maxX - x, S: r.maxZ - z };
    const door = d[r.door];
    const closed = Math.min(...(['W', 'N', 'E', 'S'] as const).filter((s) => s !== r.door).map((s) => d[s]));
    const v = smoothstep(WALL_OUT, WALL_IN, closed) * smoothstep(-DOOR_OUT, DOOR_IN, door) * (1 - smoothstep(r.ceiling + 0.02, r.ceiling + 0.2, y)) * (y > r.floor - 1 ? 1 : 0);
    k = Math.max(k, v);
  }
  return k;
}

/** The [sky, sun, reflection] light factors at a point: 1 outdoors, INTERIOR_SKY / INTERIOR_SUN / INTERIOR_REFLECT deep inside. */
export function interiorLight(list: readonly Interior[], x: number, y: number, z: number): [number, number, number] {
  const k = insideness(list, x, y, z);
  return [1 + (INTERIOR_SKY - 1) * k, 1 + (INTERIOR_SUN - 1) * k, 1 + (INTERIOR_REFLECT - 1) * k];
}

const IDS = Array.from({ length: MAX_INTERIORS }, (_, i) => i);

const PARS = /* glsl */ `
${IDS.map((i) => `uniform vec4 gta7InteriorRect${i};\nuniform vec4 gta7InteriorDoor${i};\nuniform vec2 gta7InteriorSpan${i};`).join('\n')}
uniform int gta7InteriorCount;
uniform vec3 gta7InteriorLight;
uniform sampler2D gta7WallField;
// minX, minZ, 1 / extent (twice); and the occlusion's strength (0: no field, the sampler is never read).
uniform vec4 gta7WallFieldRect;
uniform float gta7WallAO;
float gta7WallOcclusion( vec3 p ) {
  if ( gta7WallAO <= 0.0 ) return 1.0;
  vec2 uv = ( p.xz - gta7WallFieldRect.xy ) * gta7WallFieldRect.zw;
  if ( any( lessThan( uv, vec2( 0.0 ) ) ) || any( greaterThan( uv, vec2( 1.0 ) ) ) ) return 1.0;
  float d = ${FIELD_MIN.toFixed(1)} + textureLod( gta7WallField, uv, 0.0 ).r * ${(FIELD_MAX - FIELD_MIN).toFixed(1)};
  return 1.0 - gta7WallAO * exp( - max( d, 0.0 ) / ${WALL_AO_REACH.toFixed(3)} ) * exp( - max( p.y - ${CURB_H.toFixed(3)}, 0.0 ) / ${WALL_AO_REACH.toFixed(3)} );
}
// How far inside one interior a world point is (0..1): r its footprint, door the open edge (one-hot W, N, E, S), span its floor and ceiling.
float gta7InsideOne( vec3 p, vec4 r, vec4 door, vec2 span ) {
  // Distances inside each edge: west, north, east, south.
  vec4 d = vec4( p.x - r.x, p.z - r.y, r.z - p.x, r.w - p.z );
  float dd = dot( d, door );
  vec4 c = d + door * 1e4;
  float dc = min( min( c.x, c.y ), min( c.z, c.w ) );
  return smoothstep( ${WALL_OUT.toFixed(2)}, ${WALL_IN.toFixed(2)}, dc ) * smoothstep( ${(-DOOR_OUT).toFixed(2)}, ${DOOR_IN.toFixed(2)}, dd )
    * ( 1.0 - smoothstep( span.y + 0.02, span.y + 0.2, p.y ) ) * step( span.x - 1.0, p.y );
}
// x: the sky's diffuse light kept here, y: the sun's, z: the sky's reflections (1 in the open). viewPos: view space.
vec3 gta7Interior( vec3 viewPos ) {
  vec3 p = ( ( vec4( viewPos, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
  float occ = gta7WallOcclusion( p );
  vec3 open = vec3( occ, 1.0, mix( 1.0, occ, ${WALL_AO_SPEC.toFixed(2)} ) );
  if ( gta7InteriorCount <= 0 ) return open;
  float k = 0.0;
${IDS.map((i) => `  if ( gta7InteriorCount > ${i} ) k = max( k, gta7InsideOne( p, gta7InteriorRect${i}, gta7InteriorDoor${i}, gta7InteriorSpan${i} ) );`).join('\n')}
  return open * mix( vec3( 1.0 ), gta7InteriorLight, k );
}
`;

const VIEW_DIR = 'vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );';
const DIR_INFO = 'getDirectionalLightInfo( directionalLight, directLight );';
const MARK = '// gta7-interior';

/** The lit built-in shaders, whose ShaderLib uniforms get the interior's. */
const LIT = ['standard', 'physical', 'lambert', 'phong', 'toon'] as const;

let installed = false;

function patchChunk(name: keyof typeof THREE.ShaderChunk, find: string, add: string): void {
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const src = chunks[name]!;
  if (src.includes(add)) return;
  if (!src.includes(find)) throw new Error(`interiorLight: three's ${name} chunk changed; the garage darkening patch no longer applies`);
  chunks[name] = src.replace(find, `${find}\n${MARK}\n${add}`);
}

/** The wall field's texture (one per field; disposed with the renderer that made it). */
export function wallFieldTexture(f: WallField): THREE.DataTexture {
  const t = new THREE.DataTexture(f.data, f.size, f.size, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.name = 'wall-field';
  t.needsUpdate = true;
  return t;
}

/**
 * Patches three's lighting chunks (once per page) and gives the lit ShaderLib shaders the interiors' uniforms and the
 * wall field (none: no wall occlusion). Call it before any material is compiled; programs compiled before it keep no
 * darkening. Throws if three's chunks changed.
 */
export function installInteriorLight(list: readonly Interior[], field: { texture: THREE.Texture; field: WallField } | null = null): void {
  if (!installed) {
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    if (!chunks.lights_pars_begin!.includes('vec3 gta7Interior(')) chunks.lights_pars_begin = PARS + chunks.lights_pars_begin;
    patchChunk('lights_fragment_begin', VIEW_DIR, 'vec3 gta7In = gta7Interior( geometryPosition );');
    patchChunk('lights_fragment_begin', DIR_INFO, 'directLight.color *= gta7In.y;');
    const end = chunks.lights_fragment_end!;
    if (!end.includes(MARK)) {
      chunks.lights_fragment_end = `${MARK}:lights_fragment_end
#if defined( RE_IndirectDiffuse )
  irradiance *= gta7In.x;
  iblIrradiance *= gta7In.x;
#endif
#if defined( RE_IndirectSpecular )
  radiance *= gta7In.z;
  clearcoatRadiance *= gta7In.z;
#endif
${end}`;
    }
    installed = true;
  }
  const rect = IDS.map(() => new THREE.Vector4());
  const door = IDS.map(() => new THREE.Vector4());
  const span = IDS.map(() => new THREE.Vector2());
  list.slice(0, MAX_INTERIORS).forEach((r, i) => {
    rect[i]!.set(r.minX, r.minZ, r.maxX, r.maxZ);
    door[i]!.set(r.door === 'W' ? 1 : 0, r.door === 'N' ? 1 : 0, r.door === 'E' ? 1 : 0, r.door === 'S' ? 1 : 0);
    span[i]!.set(r.floor, r.ceiling);
  });
  for (const id of LIT) {
    const u = THREE.ShaderLib[id].uniforms as Record<string, THREE.IUniform>;
    for (const i of IDS) {
      u[`gta7InteriorRect${i}`] = { value: rect[i] };
      u[`gta7InteriorDoor${i}`] = { value: door[i] };
      u[`gta7InteriorSpan${i}`] = { value: span[i] };
    }
    u.gta7InteriorCount = { value: Math.min(MAX_INTERIORS, list.length) };
    u.gta7InteriorLight = { value: new THREE.Vector3(INTERIOR_SKY, INTERIOR_SUN, INTERIOR_REFLECT) };
    u.gta7WallField = { value: field?.texture ?? null };
    u.gta7WallFieldRect = { value: field ? new THREE.Vector4(field.field.minX, field.field.minZ, 1 / field.field.extent, 1 / field.field.extent) : new THREE.Vector4() };
    u.gta7WallAO = { value: field ? WALL_AO : 0 };
  }
}

/** Whether the chunks carry the patch (tests). */
export function interiorLightInstalled(): boolean {
  const c = THREE.ShaderChunk as unknown as Record<string, string>;
  return installed && c.lights_fragment_end!.includes(MARK) && c.lights_fragment_begin!.includes('gta7In.y') && c.lights_pars_begin!.includes('vec3 gta7Interior(');
}
