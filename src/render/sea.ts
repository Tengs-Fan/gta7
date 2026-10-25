// The sea surface: the Gerstner waves (render/waves.ts) and the analytic shoreline patched into the sea's
// standard material, the camera-snapped wave grid drawn on High, and the software sea's shader. The sea's colour
// follows a render-only shelf that keeps falling offshore (turquoise shallows, deep blue open water), its ripples are
// warped and modulated by low-frequency noise so their tiles do not line up, and foam rings the piers' pilings.

import * as THREE from 'three';
import { BEACH_W, CURB_H, SAND_DROP, SEABED_Y, WATER_Y } from '../world/constants';
import type { Bounds, Rect } from '../world/layout';
import { CALM_SEA, COARSE_CELL, COARSE_EXTENT, FINE_EXTENT, SEA_SLOPE2_GLSL, SEA_WAVES_GLSL, SKIRT_EXTENT, wavePhases } from './waves';

/** The sand's drop-off into deep water past the beach's end (CityView.buildCoast), m. */
const DROP_OFF = 25;
/** Shallows colour over sand, and the wet sand seen through the thinnest water (sRGB). */
const SHALLOW = 0x2fa89e;
const SAND_TINT = 0x86a89a;
/** Open water past ~15 m and far offshore (sRGB): the albedo the shelf fades to (seaShallows). */
const DEEP = 0x0b4f78;
const ABYSS = 0x062c52;
/**
 * The drawn seabed keeps falling offshore past the sim's flat SEABED_Y (render only; the sim's waterDepth stays as it
 * is): SHELF_SLOPE m per m beyond SHELF_START m outside the land rectangle (where the beach's drop-off ends).
 */
export const SHELF_SLOPE = 0.11;
export const SHELF_START = DROP_OFF;

/** The piers' pilings (CityView.buildCoast): along each deck from minX + PILING_START every PILING_STEP m, PILING_INSET in from both long sides. */
export const PILING_START = 2;
export const PILING_STEP = 7;
export const PILING_INSET = 0.6;
export const PILING_RADIUS = 0.25;
/** Decks the sea shader looks for pilings under (the layout has five). */
export const MAX_PILING_DECKS = 8;
/** Water depths (m) over which the beach's surf bands fade in seaward of the swash (4.1-7.6 m out on the 1:34 sand). */
export const SURF_BAND_FADE = [0.12, 0.22] as const;
/** Piling foam reaches at most this far (m) out from a piling's side. */
export const PILING_FOAM = 0.7;
/**
 * Far off, the ring widens to cover at least PILING_FOAM_PX screen pixels (its footprint, m per pixel, grows with
 * distance and grazing angle), up to PILING_FOAM_FAR m: at 0.7 m it thins to a pixel at 30 m and vanishes.
 */
export const PILING_FOAM_PX = 2.5;
export const PILING_FOAM_FAR = 1.1;
/**
 * Foam scatters the sky's light more than the water's albedo does: its indirect light is raised by this share. Under a
 * deck (in the sun's shadow) that keeps it a white ring rather than a faint arc against the sky the water reflects;
 * at night it scales the dim sky light, so it does not glow.
 */
export const FOAM_SKY_LIFT = 1.6;

/**
 * World-space scales of the sea's ripple warp and macro modulation samples (1 / m), see patchSeaMaterial. The gains
 * (in ripple tiles) keep the warp gentle enough not to fold the tile: about twice these fold it into streaks that fan
 * out across the foreground, and a third of them leaves the tiles' repeats lined up a few metres apart.
 */
export const RIPPLE_WARP = { a: 1 / 263, b: 1 / 97, gainA: 1.1, gainB: 0.35, macro: 1 / 181 } as const;
/** The third ripple layer: its tile (m) against the first layer's 6000 / 900 m, and its turn. */
export const RIPPLE_C = { tile: 2.43, cos: 0.37, sin: 0.93, weight: 0.5 } as const;
/**
 * The fourth ripple layer: the first layer's tile turned 53 degrees the other way and shrunk by `scale` (tile 4.0 m;
 * against the other layers 1.66, 4.46 and 1.65 times, all far from whole numbers). Its share of the ripple power, with
 * the first two layers turned down by RIPPLE_AB_GAIN, keeps the longest trains of the first layer from showing as a
 * regular pattern a few metres across.
 */
export const RIPPLE_D = { scale: 1.66, cos: 0.6, sin: 0.8, weight: 0.55 } as const;
/** The first two (Environment) ripple layers' strength under the third and fourth. */
export const RIPPLE_AB_GAIN = 0.8;
/** The first ripple layer's tile (m): the 6 km plane's UV repeated 900 times (Environment). */
export const RIPPLE_A_TILE = 6000 / 900;

/** Centres of a deck's pilings that stand in water deeper than -0.1 m (as drawn by CityView.buildCoast). */
export function pilingCentres(rect: Rect, baseGround: (x: number, z: number) => number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (let x = rect.minX + PILING_START; x < rect.maxX; x += PILING_STEP) {
    for (const z of [rect.minZ + PILING_INSET, rect.maxZ - PILING_INSET]) if (WATER_Y > baseGround(x, z) - 0.1) out.push({ x, z });
  }
  return out;
}

/** CPU twin of the shader's seaShelf: the drawn seabed's depth at sim depth `simDepth`, `outside` m out of the land rectangle. */
export function seaShelfDepth(simDepth: number, outside: number): number {
  return simDepth + SHELF_SLOPE * Math.max(0, outside - SHELF_START);
}

/** Distance (m) of (x, z) outside the land rectangle with the beach (the shader's seaQuay). */
export function outsideLand(b: Bounds, x: number, z: number): number {
  const dx = Math.max(b.landMinX - x, x - b.beachEndX, 0);
  const dz = Math.max(b.landMinZ - z, z - b.landMaxZ, 0);
  return Math.hypot(dx, dz);
}

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** CPU twin of the shader's seaDepthAt: the analytic water depth over the beach slope, its drop-off and the deep. */
export function seaDepthCpu(b: Bounds, x: number, z: number): number {
  const xc = clamp(x, b.beachStartX, b.beachEndX + DROP_OFF);
  const endY = CURB_H - SAND_DROP;
  const sand = xc <= b.beachEndX ? CURB_H - ((xc - b.beachStartX) / BEACH_W) * SAND_DROP : endY + (SEABED_Y - endY) * ((xc - b.beachEndX) / DROP_OFF);
  const out = Math.hypot(x - xc, z - clamp(z, b.landMinZ, b.landMaxZ));
  const shelf = WATER_Y - sand;
  return shelf + (WATER_Y - SEABED_Y - shelf) * smooth(0, 40, out);
}

/** The depth the sea's colour is drawn with at (x, z): seaDepthCpu, falling on along the shelf offshore. */
export function seaDrawnDepth(b: Bounds, x: number, z: number): number {
  return seaShelfDepth(seaDepthCpu(b, x, z), outsideLand(b, x, z));
}

/** Uniforms shared by every material that follows the sea: the sea itself and the foam rings on it. */
export interface SeaUniforms {
  uWavePhase: { value: THREE.Vector4 };
  uSeaAmp: { value: number };
  uDisplace: { value: number };
  uSeaOrigin: { value: THREE.Vector2 };
  /** Surf bands' and quay-foam pulse's phases (rad, each wrapped after its own rate), and the foam noise's drift. */
  uSurfPhase: { value: number };
  uQuayPhase: { value: number };
  uFoamDrift: { value: THREE.Vector2 };
  /** landMinX, landMinZ, landMaxZ, beachEndX. */
  uShoreLand: { value: THREE.Vector4 };
  /** beachStartX, BEACH_W, SAND_DROP, CURB_H. */
  uShoreBeach: { value: THREE.Vector4 };
  uShallow: { value: THREE.Color };
  uSandTint: { value: THREE.Color };
  uSeaDeep: { value: THREE.Color };
  uSeaAbyss: { value: THREE.Color };
  /** Deck rectangles (minX, minZ, maxX, maxZ) whose pilings get foam; unused slots lie far away. */
  uPilings: { value: THREE.Vector4[] };
}

export function seaUniforms(): SeaUniforms {
  return {
    uWavePhase: { value: new THREE.Vector4() },
    uSeaAmp: { value: CALM_SEA },
    uDisplace: { value: 0 },
    uSeaOrigin: { value: new THREE.Vector2() },
    uSurfPhase: { value: 0 },
    uQuayPhase: { value: 0 },
    uFoamDrift: { value: new THREE.Vector2() },
    // No land until setShore: deep water everywhere.
    uShoreLand: { value: new THREE.Vector4(1e6, 1e6, -1e6, -1e6) },
    uShoreBeach: { value: new THREE.Vector4(1e6, BEACH_W, SAND_DROP, CURB_H) },
    uShallow: { value: new THREE.Color(SHALLOW) },
    uSandTint: { value: new THREE.Color(SAND_TINT) },
    uSeaDeep: { value: new THREE.Color(DEEP) },
    uSeaAbyss: { value: new THREE.Color(ABYSS) },
    uPilings: { value: Array.from({ length: MAX_PILING_DECKS }, () => new THREE.Vector4(1e6, 1e6, 1e6, 1e6)) },
  };
}

/** Feeds the shoreline the layout's land rectangle and beach (staticWorld.baseGround's terrain). */
export function setShore(u: SeaUniforms, b: Bounds): void {
  u.uShoreLand.value.set(b.landMinX, b.landMinZ, b.landMaxZ, b.beachEndX);
  u.uShoreBeach.value.set(b.beachStartX, BEACH_W, SAND_DROP, CURB_H);
}

/** Feeds the piling foam the piers' deck rectangles (layout.decks). */
export function setPilings(u: SeaUniforms, decks: ReadonlyArray<{ rect: Rect }>): void {
  u.uPilings.value.forEach((v, i) => {
    const d = decks[i];
    if (d) v.set(d.rect.minX, d.rect.minZ, d.rect.maxX, d.rect.maxZ);
    else v.set(1e6, 1e6, 1e6, 1e6);
  });
}

const tmpPhases = [0, 0, 0, 0];
const SURF_RATE = 1.2;
/** The quay foam pulses this much faster than the surf bands roll in. */
const QUAY_PULSE = 1.4;

/** The surf bands' and quay pulse's phases at renderer time `time`, wrapped to [0, 2pi) after their rates apply. */
export function surfPhases(time: number): { surf: number; quay: number } {
  const TAU = Math.PI * 2;
  return { surf: (time * SURF_RATE) % TAU, quay: (time * SURF_RATE * QUAY_PULSE) % TAU };
}

/** Per frame: the waves' phases at renderer time `time`, the sea state, and the grid's centre. */
export function updateSea(u: SeaUniforms, time: number, seaState: number, originX: number, originZ: number): void {
  const p = wavePhases(time, tmpPhases);
  u.uWavePhase.value.set(p[0]!, p[1]!, p[2]!, p[3]!);
  u.uSeaAmp.value = Math.min(1, Math.max(0, seaState));
  u.uSeaOrigin.value.set(originX, originZ);
  const phases = surfPhases(time);
  u.uSurfPhase.value = phases.surf;
  u.uQuayPhase.value = phases.quay;
  u.uFoamDrift.value.set((time * 0.013) % 1, (time * 0.009) % 1);
}

const n = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/**
 * Water depth over the analytic terrain (staticWorld.baseGround): the beach's sand slope and its drop-off, deep
 * water elsewhere. Off the beach's ends the sand fades into the deep over SHORE_BLEND m so the shallows do not
 * end in a hard edge.
 */
export const SHORE_GLSL = /* glsl */ `
uniform vec4 uShoreLand;
uniform vec4 uShoreBeach;
uniform float uSurfPhase;
uniform float uQuayPhase;
uniform vec2 uFoamDrift;
uniform vec3 uShallow;
uniform vec3 uSandTint;
uniform vec3 uSeaDeep;
uniform vec3 uSeaAbyss;
uniform vec4 uPilings[${MAX_PILING_DECKS}];
float seaBeachOut(vec2 p) {
  vec2 c = vec2(clamp(p.x, uShoreBeach.x, uShoreLand.w + ${n(DROP_OFF)}), clamp(p.y, uShoreLand.y, uShoreLand.z));
  return length(p - c);
}
float seaDepthAt(vec2 p) {
  float x = clamp(p.x, uShoreBeach.x, uShoreLand.w + ${n(DROP_OFF)});
  float endY = uShoreBeach.w - uShoreBeach.z;
  float sand = x <= uShoreLand.w
    ? uShoreBeach.w - (x - uShoreBeach.x) / uShoreBeach.y * uShoreBeach.z
    : mix(endY, ${n(SEABED_Y)}, (x - uShoreLand.w) / ${n(DROP_OFF)});
  float shelf = ${n(WATER_Y)} - sand;
  return mix(shelf, ${n(WATER_Y - SEABED_Y)}, smoothstep(0.0, 40.0, seaBeachOut(p)));
}
/** Distance outside the land rectangle (0 inside), and how much of it is a quay wall rather than the beach. */
float seaQuay(vec2 p) {
  float dx = max(max(uShoreLand.x - p.x, p.x - uShoreLand.w), 0.0);
  float dz = max(max(uShoreLand.y - p.y, p.y - uShoreLand.z), 0.0);
  return length(vec2(dx, dz));
}
/** The drawn seabed's depth: the sim's near land, falling on along the shelf offshore (seaShelfDepth). */
float seaShelf(vec2 p, float depth) {
  return depth + ${n(SHELF_SLOPE)} * max(seaQuay(p) - ${n(SHELF_START)}, 0.0);
}
/** Foam 0..1 round the pilings of the decks in uPilings (the lattice of CityView.buildCoast); px: m per screen pixel. */
float seaPilingFoam(vec2 p, float noise, float px) {
  float best = 1e3;
  for (int i = 0; i < ${MAX_PILING_DECKS}; i++) {
    vec4 r = uPilings[i];
    if (p.x < r.x - 2.0 || p.x > r.z + 2.0 || p.y < r.y - 2.0 || p.y > r.w + 2.0) continue;
    float last = floor((r.z - r.x - ${n(PILING_START)} - 1e-3) / ${n(PILING_STEP)});
    float k = clamp(floor((p.x - r.x - ${n(PILING_START)}) / ${n(PILING_STEP)} + 0.5), 0.0, last);
    float z0 = r.y + ${n(PILING_INSET)};
    float z1 = r.w - ${n(PILING_INSET)};
    vec2 c = vec2(r.x + ${n(PILING_START)} + ${n(PILING_STEP)} * k, abs(p.y - z0) < abs(p.y - z1) ? z0 : z1);
    best = min(best, length(p - c));
  }
  float side = best - ${n(PILING_RADIUS)};
  float far = smoothstep(0.03, 0.15, px);
  float width = max(min(0.3 + 0.35 * noise, ${n(PILING_FOAM)}), min(${n(PILING_FOAM_PX)} * px, ${n(PILING_FOAM_FAR)}));
  float pulse = mix(0.75 + 0.25 * sin(uQuayPhase * 1.3 - best * 5.0), 1.0, far);
  return clamp((1.0 - smoothstep(width * 0.55, width, side)) * step(-0.05, side) * pulse * (0.8 + 0.4 * mix(noise, 1.0, far)), 0.0, 1.0);
}
float seaWaterlineX() {
  return uShoreBeach.x + uShoreBeach.y * (uShoreBeach.w - ${n(WATER_Y)}) / uShoreBeach.z;
}
/**
 * Foam 0..1: surf bands moving shoreward over the beach, the swash along the waterline, a pulsing strip along the quay
 * walls, and rings round the pilings (px: m per screen pixel).
 */
float seaFoam(vec2 p, float depth, float noise, float sea, float px) {
  float onBeach = 1.0 - smoothstep(0.0, 4.0, seaBeachOut(p));
  float reach = 0.6 + 0.9 * sea;
  float shore = 1.0 - smoothstep(0.0, reach, depth);
  float band = 0.5 + 0.5 * sin(depth * 12.566 + uSurfPhase + noise * 2.0);
  // The bands dissolve 4-8 m out (0.12-0.22 m deep), short of the swash, so they never merge with it into a sheet and
  // the foam at the waterline stays a band that hugs it.
  float bands = smoothstep(0.55, 0.9, band + (noise - 0.5) * 0.5) * shore * smoothstep(${n(SURF_BAND_FADE[0])}, ${n(SURF_BAND_FADE[1])}, depth);
  // The swash surges up the sand and draws back with the surf phase (1.3-2.5 m out at sea state 0.3).
  float surge = 0.5 + 0.5 * sin(uSurfPhase + 1.7 + noise * 1.5);
  float swash = 1.0 - smoothstep(0.0, (0.04 + 0.06 * sea) * (0.65 + 0.6 * surge), depth);
  float beach = clamp((bands * (0.55 + 0.6 * sea) + swash * 0.8) * onBeach, 0.0, 1.0);
  float d = seaQuay(p);
  float width = 0.5 + 1.0 * smoothstep(0.3, 0.7, noise);
  float pulse = 0.8 + 0.2 * sin(uQuayPhase + (p.x + p.y) * 0.21);
  float notBeach = 1.0 - smoothstep(seaWaterlineX() - 5.0, seaWaterlineX() + 10.0, p.x);
  float quay = (1.0 - smoothstep(width * 0.4, width, d)) * step(1e-3, d) * pulse * notBeach * (0.85 + 0.3 * sea) * (0.75 + 0.5 * noise);
  return clamp(max(max(beach, quay), seaPilingFoam(p, noise, px)), 0.0, 1.0);
}
/**
 * The sea's albedo by depth: wet sand through the thinnest water, turquoise shallows, the material's own colour (mid)
 * by 4 m, then deep blue and the dark offshore blue as the drawn shelf falls away (seaShelf).
 */
vec3 seaShallows(vec3 mid, float depth, vec2 p) {
  float shelf = seaShelf(p, depth);
  vec3 c = mix(uShallow, mid, smoothstep(0.0, 4.0, depth));
  // Overlapping ramps, so the colour keeps darkening steadily with depth rather than pausing between them.
  c = mix(c, uSeaDeep, smoothstep(4.0, 18.0, shelf));
  c = mix(c, uSeaAbyss, smoothstep(10.0, 45.0, shelf));
  return mix(uSandTint, c, smoothstep(0.0, 0.15, depth));
}
`;

/** Waves damp to this share of their height where the water is shallowest, so the waterline stays near the sim's. */
export const SHORE_DAMP = 0.35;

/**
 * Patches the sea's (already ripple-patched) standard material: world-anchored ripple UVs (the mesh follows the
 * camera), vertex displacement scaled by uDisplace (damped over the shallows), the ripples warped and their strength
 * modulated by low-frequency samples of the ripple tile itself, a third and a fourth ripple layer, the wave slopes added to the
 * ripple normal, the shallows' colour and foam. Only uniforms change at runtime: the grid on or off and the sea state
 * never rebuild the program.
 */
export function patchSeaMaterial(mat: THREE.MeshStandardMaterial, u: SeaUniforms): void {
  const ripples = mat.onBeforeCompile.bind(mat);
  const key = mat.customProgramCacheKey.bind(mat);
  const c = RIPPLE_C;
  const cScale = RIPPLE_A_TILE / c.tile;
  const d = RIPPLE_D;
  mat.onBeforeCompile = (shader, renderer) => {
    ripples(shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SEA_WAVES_GLSL}\n${SHORE_GLSL}\nattribute vec2 aEdge;\nvarying vec2 vSeaXZ;`)
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
  vec4 seaBase = modelMatrix * vec4( position, 1.0 );
  vSeaXZ = seaBase.xz;
#ifdef USE_NORMALMAP
  // The ripple tile is anchored to the world (one plane 6 km across had UV 0..1), not to the moving mesh.
  vNormalMapUv = ( normalMapTransform * vec3( seaBase.x / 6000.0 + 0.5, 0.5 - seaBase.z / 6000.0, 1.0 ) ).xy;
#endif`,
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n  transformed += uDisplace * seaDisplaceEdge( seaBase.xz, aEdge ) * mix( ${n(SHORE_DAMP)}, 1.0, smoothstep( 0.0, 2.0, seaDepthAt( seaBase.xz ) ) );`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>\n${SEA_WAVES_GLSL}\n${SHORE_GLSL}\nvarying vec2 vSeaXZ;`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float seaDepth = seaDepthAt( vSeaXZ );
  float seaFoamAmt = 0.0;
#ifdef USE_NORMALMAP
  {
    vec2 fuv = vSeaXZ * 0.031 + uFoamDrift;
    float seaNoise = texture2D( normalMap, fuv ).x * 0.6 + texture2D( normalMap, fuv * 2.37 + 0.31 ).y * 0.4;
    seaFoamAmt = seaFoam( vSeaXZ, seaDepth, seaNoise, uSeaAmp, length( fwidth( vSeaXZ ) ) );
  }
#endif
  diffuseColor.rgb = mix( seaShallows( diffuseColor.rgb, seaDepth, vSeaXZ ), vec3( 0.82, 0.86, 0.86 ), seaFoamAmt );`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix( roughnessFactor, 0.85, seaFoamAmt );')
      .replace('#include <aomap_fragment>', `reflectedLight.indirectDiffuse *= 1.0 + ${n(FOAM_SKY_LIFT)} * seaFoamAmt;\n#include <aomap_fragment>`)
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
#ifdef USE_NORMALMAP
  // Low-frequency samples of the ripple tile warp its UV (so its repeats never line up) and scale its strength.
  vec2 seaWarp = ( texture2D( normalMap, vSeaXZ * ${n(RIPPLE_WARP.a)} + vec2( 0.21, 0.57 ) ).xy - 0.5 ) * ${n(RIPPLE_WARP.gainA)}
    + ( texture2D( normalMap, vSeaXZ * ${n(RIPPLE_WARP.b)} + vec2( 0.63, 0.12 ) ).yx - 0.5 ) * ${n(RIPPLE_WARP.gainB)};
  vec2 seaRippleUv = vNormalMapUv + seaWarp;
  vec2 seaNormalScale = normalScale * ( 0.85 + 0.3 * smoothstep( 0.4, 0.6, texture2D( normalMap, vSeaXZ * ${n(RIPPLE_WARP.macro)} + vec2( 0.4, 0.9 ) ).x ) );
  vec2 seaNormalScaleAB = seaNormalScale * ${n(RIPPLE_AB_GAIN)};
#define vNormalMapUv seaRippleUv
#define normalScale seaNormalScaleAB
#endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `{
    vec2 seaS = seaSlope( vSeaXZ, distance( cameraPosition.xz, vSeaXZ ) ) * ( 1.0 - 0.6 * seaFoamAmt );
#ifdef USE_NORMALMAP
    // A third, finer ripple layer, turned and drifting its own way (uFoamDrift wraps at 1: whole tiles of this layer).
    vec2 seaCuv = mat2( ${n(c.cos)}, ${n(-c.sin)}, ${n(c.sin)}, ${n(c.cos)} ) * seaRippleUv * ${n(cScale)} + uFoamDrift.yx * 3.0;
    seaS += ( texture2D( normalMap, seaCuv ).xy * 2.0 - 1.0 ) * seaNormalScale * ${n(c.weight)};
    // A fourth layer at the first one's scale, turned the other way (uFoamDrift times a whole number wraps by whole tiles).
    vec2 seaDuv = mat2( ${n(d.cos)}, ${n(d.sin)}, ${n(-d.sin)}, ${n(d.cos)} ) * seaRippleUv * ${n(d.scale)} - uFoamDrift * 2.0 + vec2( 0.37, 0.71 );
    seaS += ( texture2D( normalMap, seaDuv ).xy * 2.0 - 1.0 ) * seaNormalScale * ${n(d.weight)};
#endif
    normal = normalize( normal + mat3( viewMatrix ) * vec3( -seaS.x, 0.0, -seaS.y ) );
  }
#include <emissivemap_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => `${key()}-waves`;
}

/** The software sea: two waves on a warped ripple, the shallows and the beach's surf. Shares SeaUniforms. */
export function softwareSeaMaterial(u: SeaUniforms, extra: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog!), ...extra, ...u },
    vertexShader: `varying vec3 vWorld;\n#include <common>\n#include <fog_pars_vertex>
      void main() { vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `varying vec3 vWorld;
      uniform sampler2D uNormal; uniform vec2 uDrift;
      uniform vec3 uTop, uHorizon; uniform float uNight;
      #include <common>
      #include <fog_pars_fragment>
      ${SEA_WAVES_GLSL}
      ${SEA_SLOPE2_GLSL}
      ${SHORE_GLSL}
      void main() {
        vec2 warp = (texture2D(uNormal, vWorld.xz * ${n(RIPPLE_WARP.a)} + vec2(0.21, 0.57)).xy - 0.5) * ${n(RIPPLE_WARP.gainA)};
        vec3 ripple = texture2D(uNormal, vWorld.xz * 0.15 + uDrift + warp).xyz;
        vec2 wave = ripple.xy * 2.0 - 1.0;
        vec2 swell = seaSlope2(vWorld.xz);
        vec3 n = normalize(vec3(wave.x * 0.18 - swell.x, 1.0, wave.y * 0.18 - swell.y));
        vec3 eye = normalize(cameraPosition - vWorld);
        vec3 reflection = reflect(-eye, n);
        vec3 sky = mix(uHorizon, uTop, smoothstep(0.0, 0.6, reflection.y));
        float fresnel = 1.0 - max(dot(n, eye), 0.0);
        fresnel *= fresnel;
        float depth = seaDepthAt(vWorld.xz);
        float light = 1.0 - uNight * 0.94;
        vec3 sea = seaShallows(vec3(0.018, 0.17, 0.23), depth, vWorld.xz) * light;
        float onBeach = 1.0 - smoothstep(0.0, 4.0, seaBeachOut(vWorld.xz));
        float shore = 1.0 - smoothstep(0.0, 0.6 + 0.9 * uSeaAmp, depth);
        float band = smoothstep(0.6, 0.9, 0.5 + 0.5 * sin(depth * 12.566 + uSurfPhase + ripple.z * 2.0));
        float foam = clamp(band * shore * onBeach * (0.55 + 0.6 * uSeaAmp), 0.0, 1.0);
        vec3 col = mix(sea, sky, (0.25 + fresnel * 0.65) * (1.0 - foam));
        gl_FragColor = vec4(mix(col, vec3(0.8) * light, foam), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}
/** The plane drawn on every tier but High (and on software), centred on the camera like the grid. */
export function seaPlane(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(SKIRT_EXTENT * 2, SKIRT_EXTENT * 2).rotateX(-Math.PI / 2);
  g.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  return g;
}

/**
 * High's wave grid in XZ around its centre: 1 m cells to FINE_EXTENT, COARSE_CELL cells to COARSE_EXTENT, then a
 * flat skirt to SKIRT_EXTENT whose inner rim shares the coarse ring's vertices. The fine ring's rim vertices that
 * fall between coarse ones carry aEdge (the rim's direction), so the shader puts them on the coarse ring's edges.
 * The mesh is moved in whole COARSE_CELL steps (Environment), so every vertex stays on a fixed world lattice.
 */
export function seaGrid(): THREE.BufferGeometry {
  const pos: number[] = [];
  const edge: number[] = [];
  const index: number[] = [];
  const vertex = (x: number, z: number, ex = 0, ez = 0): number => {
    pos.push(x, 0, z);
    edge.push(ex, ez);
    return pos.length / 3 - 1;
  };
  const grid = (half: number, cell: number, hole: number, rim: boolean): void => {
    const cells = Math.round((half * 2) / cell);
    const ids: number[] = [];
    for (let j = 0; j <= cells; j++) {
      for (let i = 0; i <= cells; i++) {
        const x = -half + i * cell;
        const z = -half + j * cell;
        if (Math.max(Math.abs(x), Math.abs(z)) < hole) {
          ids.push(-1);
          continue;
        }
        let ex = 0;
        let ez = 0;
        if (rim) {
          // On the rim and between two coarse vertices: slide along the rim.
          if (Math.abs(z) === half && x % COARSE_CELL !== 0) ex = 1;
          else if (Math.abs(x) === half && z % COARSE_CELL !== 0) ez = 1;
        }
        ids.push(vertex(x, z, ex, ez));
      }
    }
    const at = (i: number, j: number) => ids[j * (cells + 1) + i]!;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const cx = -half + (i + 0.5) * cell;
        const cz = -half + (j + 0.5) * cell;
        if (Math.max(Math.abs(cx), Math.abs(cz)) < hole) continue;
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i, j + 1);
        const d = at(i + 1, j + 1);
        // Counter-clockwise seen from above (+y).
        index.push(a, c, b, b, c, d);
      }
    }
  };
  grid(FINE_EXTENT, 1, 0, true);
  grid(COARSE_EXTENT, COARSE_CELL, FINE_EXTENT, false);
  // The skirt: per side, a strip of quads from the coarse rim out to SKIRT_EXTENT, flat (the waves have faded out).
  const steps = Math.round((COARSE_EXTENT * 2) / COARSE_CELL);
  const k = SKIRT_EXTENT / COARSE_EXTENT;
  const sides: Array<(t: number) => [number, number]> = [
    (t) => [t, -COARSE_EXTENT],
    (t) => [COARSE_EXTENT, t],
    (t) => [-t, COARSE_EXTENT],
    (t) => [-COARSE_EXTENT, -t],
  ];
  for (const side of sides) {
    for (let i = 0; i < steps; i++) {
      const [x0, z0] = side(-COARSE_EXTENT + i * COARSE_CELL);
      const [x1, z1] = side(-COARSE_EXTENT + (i + 1) * COARSE_CELL);
      const a = vertex(x0, z0);
      const b = vertex(x1, z1);
      const c = vertex(x0 * k, z0 * k);
      const d = vertex(x1 * k, z1 * k);
      index.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  const count = pos.length / 3;
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  // Never read (the shader works the ripple UV out from the world position), but three's shader declares it.
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 2));
  g.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKIRT_EXTENT * Math.SQRT2);
  return g;
}

/** Where the grid's centre goes for a camera at (x, z): whole COARSE_CELL steps, so its vertices never swim. */
export function snapSea(v: number): number {
  return Math.round(v / COARSE_CELL) * COARSE_CELL;
}
