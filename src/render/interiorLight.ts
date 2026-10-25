// Darker garage interiors. Under a garage's roof the sky's light (the hemisphere fill and the image-based light) and the
// sun's are cut to a share, so the shell no longer reads as lit like outdoors; lamps, headlights and any light inside
// keep their strength. One patch of three's lighting chunks, installed before the first program is built, so every lit
// built-in material (and any material an asset brings) gets it with no change of its own and no new program. It works
// from the fragment's world position, so a car or person crossing the door fades smoothly between the two.
//
// Tiers: High, Medium and Low (hardware). The software tier's vertex-lit stand-ins replace these chunks (no darkening).

import * as THREE from 'three';
import type { Garage } from '../world/layout';

/** Garages the shader can hold (the city has four). */
export const MAX_INTERIORS = 8;
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

const PARS = /* glsl */ `
uniform vec4 gta7InteriorRect[ ${MAX_INTERIORS} ];
uniform vec4 gta7InteriorDoor[ ${MAX_INTERIORS} ];
uniform vec4 gta7InteriorSpan[ ${MAX_INTERIORS} ];
uniform int gta7InteriorCount;
uniform vec3 gta7InteriorLight;
// x: the sky's diffuse light kept here, y: the sun's, z: the sky's reflections (1 outdoors). viewPos: view space.
vec3 gta7Interior( vec3 viewPos ) {
  if ( gta7InteriorCount <= 0 ) return vec3( 1.0 );
  vec3 p = ( ( vec4( viewPos, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
  float k = 0.0;
  for ( int i = 0; i < ${MAX_INTERIORS}; i ++ ) {
    if ( i >= gta7InteriorCount ) break;
    vec4 r = gta7InteriorRect[ i ];
    vec4 door = gta7InteriorDoor[ i ];
    vec4 span = gta7InteriorSpan[ i ];
    // Distances inside each edge: west, north, east, south.
    vec4 d = vec4( p.x - r.x, p.z - r.y, r.z - p.x, r.w - p.z );
    float dd = dot( d, door );
    vec4 c = d + door * 1e4;
    float dc = min( min( c.x, c.y ), min( c.z, c.w ) );
    float v = smoothstep( ${WALL_OUT.toFixed(2)}, ${WALL_IN.toFixed(2)}, dc ) * smoothstep( ${(-DOOR_OUT).toFixed(2)}, ${DOOR_IN.toFixed(2)}, dd )
      * ( 1.0 - smoothstep( span.y + 0.02, span.y + 0.2, p.y ) ) * step( span.x - 1.0, p.y );
    k = max( k, v );
  }
  return mix( vec3( 1.0 ), gta7InteriorLight, k );
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

/**
 * Patches three's lighting chunks (once per page) and gives the lit ShaderLib shaders the interiors' uniforms. Call it
 * before any material is compiled; programs compiled before it keep no darkening. Throws if three's chunks changed.
 */
export function installInteriorLight(list: readonly Interior[]): void {
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
  const rect = Array.from({ length: MAX_INTERIORS }, () => new THREE.Vector4());
  const door = Array.from({ length: MAX_INTERIORS }, () => new THREE.Vector4());
  const span = Array.from({ length: MAX_INTERIORS }, () => new THREE.Vector4());
  list.slice(0, MAX_INTERIORS).forEach((r, i) => {
    rect[i]!.set(r.minX, r.minZ, r.maxX, r.maxZ);
    door[i]!.set(r.door === 'W' ? 1 : 0, r.door === 'N' ? 1 : 0, r.door === 'E' ? 1 : 0, r.door === 'S' ? 1 : 0);
    span[i]!.set(r.floor, r.ceiling, 0, 0);
  });
  for (const id of LIT) {
    const u = THREE.ShaderLib[id].uniforms as Record<string, THREE.IUniform>;
    u.gta7InteriorRect = { value: rect };
    u.gta7InteriorDoor = { value: door };
    u.gta7InteriorSpan = { value: span };
    u.gta7InteriorCount = { value: Math.min(MAX_INTERIORS, list.length) };
    u.gta7InteriorLight = { value: new THREE.Vector3(INTERIOR_SKY, INTERIOR_SUN, INTERIOR_REFLECT) };
  }
}

/** Whether the chunks carry the patch (tests). */
export function interiorLightInstalled(): boolean {
  const c = THREE.ShaderChunk as unknown as Record<string, string>;
  return installed && c.lights_fragment_end!.includes(MARK) && c.lights_fragment_begin!.includes('gta7In.y') && c.lights_pars_begin!.includes('vec3 gta7Interior(');
}
