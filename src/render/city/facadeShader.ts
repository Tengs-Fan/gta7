// Facade, trim and storefront shading shared by the city's building materials: PBR walls from the WebP sets with
// recessed windows (an analytic box recess per window cell, so the glass shifts with the view and the reveals
// shade and shadow themselves), relief sills, the night windows, and the building fog that keeps tall towers
// legible against the sky at a distance.

import * as THREE from 'three';
import type { FacadeStyle } from '../../world/layout';
import { assets } from '../assets';
import { FACADE_CELL, FACADE_COLS, FACADE_LOOK, FACADE_ROWS, FACADE_WINDOW, facadeMapIds, facadeTextures, facadeWallFallback } from '../textures';

/** Per-view switches the tiers drive through uniforms, so no tier change recompiles a program. */
export interface BuildingUniforms {
  /** 1: recessed windows and interiors (High, Medium); 0: flat-mapped (Low, software). */
  parallax: { value: number };
  /** 1: the skyline fog (hardware tiers); 0: three's own linear fog (software, which culls at its fog horizon). */
  skyline: { value: number };
}

export const NIGHT_HASH = /* glsl */ `
float nightHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`;

/**
 * Fog on buildings: three's linear fog, capped so a tower never fully dissolves into the haze while nearer ground
 * does, with the cap rising slowly with distance (aerial perspective) and less fog on high floors (the haze sits
 * low). Thick weather (a short fog distance) lifts the cap back towards full fog.
 */
const BUILDING_FOG = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    if ( uSkyline > 0.5 ) {
      float clearAir = smoothstep( 350.0, 760.0, fogFar );
      float cap = mix( 0.97, 0.45, clearAir );
      cap += ( 1.0 - cap ) * 0.5 * smoothstep( fogFar, fogFar * 3.2, vFogDepth );
      fogFactor = min( fogFactor, cap ) * ( 1.0 - 0.55 * clearAir * smoothstep( 15.0, 140.0, vBFogY ) );
    }
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

/** Adds the building fog to a shader (vertex world height varying, the uSkyline uniform, the fog chunk). */
export function patchBuildingFog(shader: THREE.WebGLProgramParametersWithUniforms, u: BuildingUniforms): void {
  shader.uniforms.uSkyline = u.skyline;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vBFogY;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBFogY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vBFogY;\nuniform float uSkyline;')
    .replace('#include <fog_fragment>', BUILDING_FOG);
}

/** A material (trim, roofs, decor) that only takes the building fog; `key` names its program. */
export function withBuildingFog<T extends THREE.Material>(mat: T, key: string, u: BuildingUniforms): T {
  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    patchBuildingFog(shader, u);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

const COLS = FACADE_COLS.toFixed(1);
const ROWS = FACADE_ROWS.toFixed(1);

const FACADE_PARS = /* glsl */ `
uniform sampler2D uWinMap;
uniform vec4 uWinRect;
uniform vec4 uWinShape;
uniform vec2 uCellM;
uniform vec4 uWallLook;
uniform vec3 uWallBase;
uniform vec4 uGlassLook;
uniform vec3 uGlassAvg;
uniform float uGlassScale;
uniform float uParallax;
uniform float uOccupancy;
uniform float uTime;
uniform float uStyleOcc;
uniform float uFloorShare;
varying vec2 vFUv;
varying vec3 vFWorld;
varying vec3 vFNormal;
${NIGHT_HASH}
// Integral of a period-1 pulse train that is 1 on [a, a + w): box-filtering it gives the window coverage of a pixel.
float fPulse(float x, float a, float w) {
  return floor(x) * w + clamp(fract(x) - a, 0.0, w);
}
float fCover(float x, float h, float a, float w) {
  h = max(h, 1e-4);
  return (fPulse(x + 0.5 * h, a, w) - fPulse(x - 0.5 * h, a, w)) / h;
}
float fPresent(vec2 cid) {
  float col = mod(cid.x, ${COLS});
  float row = ${(FACADE_ROWS - 1).toFixed(1)} - mod(cid.y, ${ROWS});
  if (uWinShape.w > 1.5) return abs(mod(col + row, 3.0) - 1.0) < 0.5 ? 0.0 : 1.0;
  if (uWinShape.w > 0.5) return mod(row, 2.0) < 0.5 ? 1.0 : 0.0;
  return 1.0;
}
float fBox(float x, float a, float b, float h) {
  return smoothstep(a - h, a + h, x) * (1.0 - smoothstep(b - h, b + h, x));
}`;

/**
 * Runs where three samples the colour map: works out this fragment's wall, reveal or glass, and leaves the
 * results in f* variables for the roughness, metalness, normal and emissive chunks that follow.
 */
const FACADE_MAIN = /* glsl */ `
vec3 fAlb;
float fRough;
float fMetal;
vec3 fNW;
vec3 fEm = vec3(0.0);
vec2 fCell;
{
  vec2 cc = vFUv * vec2(${COLS}, ${ROWS});
  vec2 cid = floor(cc);
  fCell = cid;
  vec2 pm = (cc - cid) * uCellM;
  vec3 N = normalize(vFNormal);
  vec3 U = vec3(N.z, 0.0, -N.x);
  float ul = length(U);
  U = ul > 1e-3 ? U / ul : vec3(1.0, 0.0, 0.0);
  vec3 Yv = vec3(0.0, 1.0, 0.0);
  vec2 wuv = vec2(vFUv.x * uCellM.x * ${COLS}, vFWorld.y) / uWallLook.x;
  vec4 wt = texture2D(map, wuv);
  float lum = dot(wt.rgb, vec3(0.2126, 0.7152, 0.0722)) / uWallLook.z;
  vec3 wall = mix(wt.rgb, uWallBase * lum, uWallLook.y);
  float wallRough = uGlassLook.z;
  #ifdef USE_ROUGHNESSMAP
    wallRough *= texture2D(roughnessMap, wuv).g;
  #endif
  wallRough = clamp(wallRough, 0.05, 1.0);
  vec3 wallN = N;
  #ifdef USE_NORMALMAP
    vec3 tn = texture2D(normalMap, wuv).xyz * 2.0 - 1.0;
    tn.xy *= uWallLook.w;
    wallN = normalize(U * tn.x + Yv * tn.y + N * tn.z);
  #endif
  vec2 r0 = uWinRect.xy;
  vec2 r1 = uWinRect.zw;
  bool ribbon = uWinShape.z > 0.5;
  vec2 h = fwidth(cc);
  vec2 dux = dFdx(vFUv);
  vec2 duy = dFdy(vFUv);
  float pres = fPresent(cid);
  float big = smoothstep(0.3, 1.0, max(h.x, h.y));
  float avgPres = uWinShape.w > 1.5 ? 0.6667 : (uWinShape.w > 0.5 ? 0.5 : 1.0);
  float cov = (ribbon ? 1.0 : fCover(cc.x, h.x, r0.x, r1.x - r0.x)) * fCover(cc.y, h.y, r0.y, r1.y - r0.y) * mix(pres, avgPres, big);
  // Far glass: the painted panes while a cell still spans a few pixels, their mean colour beyond.
  vec3 farGlass = mix(textureGrad(uWinMap, vFUv, dux, duy).rgb * uGlassScale, uGlassAvg, big);
  fAlb = mix(wall, farGlass, cov);
  fRough = mix(wallRough, uGlassLook.x, cov);
  fMetal = mix(uGlassLook.w, uGlassLook.y, cov);
  fNW = normalize(mix(wallN, N, cov));
  #ifdef USE_EMISSIVEMAP
    fEm = texture2D(emissiveMap, vFUv).rgb;
  #endif
  float nearK = (1.0 - smoothstep(0.04, 0.1, max(h.x, h.y))) * uParallax * (1.0 - step(0.5, abs(N.y)));
  if (nearK > 0.001) {
    vec2 m0 = r0 * uCellM;
    vec2 m1 = r1 * uCellM;
    vec2 aa = h * uCellM * 0.5;
    float open = (ribbon ? 1.0 : fBox(pm.x, m0.x, m1.x, aa.x)) * fBox(pm.y, m0.y, m1.y, aa.y) * pres;
    vec3 V = normalize(vFWorld - cameraPosition);
    vec3 Vt = vec3(dot(V, U), V.y, -dot(V, N));
    float d = uWinShape.x;
    vec2 hit = pm;
    float hd = d;
    float kind = 0.0;
    vec3 revN = N;
    if (Vt.z > 0.02) {
      float tg = d / Vt.z;
      float tx = 1e6;
      float ty = 1e6;
      if (!ribbon && abs(Vt.x) > 1e-5) tx = max(((Vt.x > 0.0 ? m1.x : m0.x) - pm.x) / Vt.x, 0.0);
      if (abs(Vt.y) > 1e-5) ty = max(((Vt.y > 0.0 ? m1.y : m0.y) - pm.y) / Vt.y, 0.0);
      float t = min(tg, min(tx, ty));
      hit = pm + Vt.xy * t;
      hd = Vt.z * t;
      if (t < tg) {
        if (tx < ty) { kind = 1.0; revN = Vt.x > 0.0 ? -U : U; }
        else { kind = 2.0; revN = Vt.y > 0.0 ? -Yv : Yv; }
      }
    }
    hit = clamp(hit, m0 + 0.002, m1 - 0.002);
    float lit = 1.0;
    #if NUM_DIR_LIGHTS > 0
      vec3 L = normalize((vec4(directionalLights[0].direction, 0.0) * viewMatrix).xyz);
      float lz = dot(L, N);
      if (lz > 0.02) {
        vec2 ex = hit + vec2(dot(L, U), L.y) * (hd / lz);
        float inside = (ribbon ? 1.0 : step(m0.x, ex.x) * step(ex.x, m1.x)) * step(m0.y, ex.y) * step(ex.y, m1.y);
        lit = mix(1.0, inside, smoothstep(0.0, 0.02, hd));
      }
    #endif
    vec2 gUv = (cid + hit / uCellM) / vec2(${COLS}, ${ROWS});
    vec3 nAlb;
    float nRough;
    float nMetal;
    vec3 nN;
    float glassK = 0.0;
    if (kind < 0.5) {
      nAlb = textureGrad(uWinMap, gUv, dux, duy).rgb * uGlassScale;
      float ph = nightHash(cid * 1.37 + vec2(3.0, 7.0));
      nN = normalize(N + U * (ph - 0.5) * 0.04 + Yv * (fract(ph * 7.31) - 0.5) * 0.04);
      nRough = uGlassLook.x;
      nMetal = uGlassLook.y;
      glassK = 1.0;
    } else {
      nAlb = wall * mix(0.9, 0.55, hd / max(d, 1e-3));
      nN = revN;
      nRough = wallRough;
      nMetal = uGlassLook.w;
    }
    nAlb *= mix(0.38, 1.0, lit);
    // The sill: a stone ledge under each opening (its lit top and its face), and the shadow it drops on the wall.
    vec3 sAlb = wall;
    vec3 sN = wallN;
    float sill = uWinShape.y;
    float sx = (ribbon ? 1.0 : step(m0.x - 0.07, pm.x) * step(pm.x, m1.x + 0.07)) * pres;
    float sy = m0.y - sill;
    if (sx > 0.5 && pm.y < m0.y && pm.y >= sy) {
      float top = smoothstep(sy + sill * 0.5, sy + sill * 0.75, pm.y);
      sN = normalize(mix(N, Yv + N * 0.25, top));
      sAlb = min(wall * 1.2 + 0.03, vec3(1.0));
    } else if (sx > 0.5 && pm.y < sy && pm.y > sy - sill * 2.0) {
      sAlb = wall * mix(0.62, 1.0, (sy - pm.y) / (sill * 2.0));
    }
    vec3 eNear = vec3(0.0);
    #ifdef USE_EMISSIVEMAP
      eNear = textureGrad(emissiveMap, gUv, dux, duy).rgb * glassK * open;
    #endif
    fAlb = mix(fAlb, mix(sAlb, nAlb, open), nearK);
    fRough = mix(fRough, mix(wallRough, nRough, open), nearK);
    fMetal = mix(fMetal, mix(uGlassLook.w, nMetal, open), nearK);
    fNW = normalize(mix(fNW, normalize(mix(sN, nN, open)), nearK));
    fEm = mix(fEm, eNear, nearK);
  }
  diffuseColor.rgb *= fAlb;
}`;

/**
 * Lit windows at night: the emissive map is only a glass mask; which windows glow is decided per window (its cell
 * on the building, never wrapping) and per building (aSeed) against the time of day's occupancy, with warm, cool
 * and flickering-TV tints. The recessed glass carries the glow, so lit panes stay inside their reveals.
 */
const FACADE_NIGHT = /* glsl */ `
#ifdef USE_EMISSIVEMAP
  totalEmissiveRadiance *= fEm;
#endif
if (dot(totalEmissiveRadiance, vec3(1.0)) > 0.001) {
  vec2 cell = fCell;
  // Whole numbers only: the hash would turn the slightest float error into per-pixel noise.
  float s = floor(vSeed * 1000.0 + 0.5);
  float hCell = nightHash(cell + vec2(s, s * 1.37 + 11.0));
  float hFloor = nightHash(vec2(cell.y * 1.13 + s, s * 0.71 + 17.0));
  float wholeFloor = step(nightHash(vec2(cell.y + 41.0, s + 3.0)), uFloorShare);
  float lit = step(mix(hCell, hFloor, wholeFloor), uOccupancy * uStyleOcc);
  float ht = nightHash(cell * 1.71 + vec2(s * 0.37 + 5.0, 9.0));
  vec3 tint = vec3(1.0, 0.66, 0.36);
  if (ht > 0.75) tint = vec3(0.75, 0.86, 1.0);
  if (ht > 0.95) tint = vec3(0.32, 0.5, 1.0) * (0.6 + 0.4 * sin(uTime * 7.0 + ht * 60.0) * sin(uTime * 2.3 + ht * 17.0));
  float bright = 0.7 + 0.3 * nightHash(cell * 0.73 + vec2(9.0, s));
  totalEmissiveRadiance *= lit * bright * tint;
}`;

const FACADE_STYLE_NIGHT: Record<FacadeStyle, { occ: number; floors: number }> = {
  glassBlue: { occ: 0.8, floors: 0.5 },
  glassTeal: { occ: 0.8, floors: 0.5 },
  office: { occ: 0.85, floors: 0.5 },
  brick: { occ: 1, floors: 0 },
  stucco: { occ: 1, floors: 0 },
  house: { occ: 1.05, floors: 0 },
  warehouse: { occ: 0.35, floors: 0 },
  hotel: { occ: 1.1, floors: 0 },
};

export const FACADE_PROGRAM = 'gta7-facade-v3';

/** The textures a facade material draws from, with where they came from (asset ids for the WebP sets). */
export interface FacadeMaps {
  map: THREE.Texture;
  normal: THREE.Texture;
  orm: THREE.Texture;
  /** True when all three came from the WebP sets in src/assets/textures. */
  pbr: boolean;
}

/** Own copies of the loaded wall maps (anisotropy is set per tier on them), or the procedural stand-ins. */
export function facadeMaps(style: FacadeStyle): FacadeMaps {
  const ids = facadeMapIds(style);
  const a = assets.texture(ids.albedo);
  const n = assets.texture(ids.normal);
  const o = assets.texture(ids.orm);
  if (a && n && o) {
    const copy = (t: THREE.Texture, id: string): THREE.Texture => {
      const c = t.clone();
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.userData = { ...c.userData, assetId: id };
      c.needsUpdate = true;
      return c;
    };
    return { map: copy(a, ids.albedo), normal: copy(n, ids.normal), orm: copy(o, ids.orm), pbr: true };
  }
  const f = facadeWallFallback(style);
  return { map: f.map, normal: f.normal, orm: f.orm, pbr: false };
}

export interface FacadeMaterialUniforms {
  occupancy: { value: number };
  time: { value: number };
}

const linear = (hex: number): THREE.Color => new THREE.Color(hex);

/** The material of one facade style. Every style shares one program (per-style values are uniforms). */
export function createFacadeMaterial(style: FacadeStyle, seed: number, night: FacadeMaterialUniforms, bu: BuildingUniforms): THREE.MeshStandardMaterial {
  const look = FACADE_LOOK[style];
  const win = FACADE_WINDOW[style];
  const cell = FACADE_CELL[style];
  const tex = facadeTextures(style, seed);
  const maps = facadeMaps(style);
  const mat = new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normal,
    roughnessMap: maps.orm,
    emissiveMap: tex.emissive,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0,
    roughness: look.roughness,
    metalness: look.metalness,
    normalScale: new THREE.Vector2(look.normalScale, look.normalScale),
    vertexColors: true,
  });
  mat.name = `facade-${style}`;
  // The old painted facade is now the glass layer: blinds, curtains and tinted panes seen in the recesses.
  tex.map.name = `facade-${style}-glass`;
  const sn = FACADE_STYLE_NIGHT[style];
  const uniforms = {
    uWinMap: { value: tex.map },
    uWinRect: { value: new THREE.Vector4(win.x0, win.y0, win.x1, win.y1) },
    uWinShape: { value: new THREE.Vector4(win.depth, win.sill, win.ribbon ? 1 : 0, win.skip) },
    uCellM: { value: new THREE.Vector2(cell.w, cell.h) },
    uWallLook: { value: new THREE.Vector4(look.tile, look.desaturate, look.meanLuma, look.normalScale) },
    uWallBase: { value: linear(look.base) },
    uGlassLook: { value: new THREE.Vector4(look.glassRoughness, look.glassMetalness, look.roughness, look.metalness) },
    uGlassAvg: { value: linear(look.glassAlbedo) },
    uGlassScale: { value: style === 'glassBlue' || style === 'glassTeal' ? 0.55 : 0.75 },
    uParallax: bu.parallax,
    uOccupancy: night.occupancy,
    uTime: night.time,
    uStyleOcc: { value: sn.occ },
    uFloorShare: { value: sn.floors },
  };
  mat.userData.facade = { style, uniforms, maps, glass: tex.map };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSeed;\nflat varying float vSeed;\nvarying vec2 vFUv;\nvarying vec3 vFWorld;\nvarying vec3 vFNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeed = aSeed;\nvFUv = uv;\nvFWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFNormal = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nflat varying float vSeed;')
      .replace('void main() {', `${FACADE_PARS}\nvoid main() {`)
      .replace('#include <map_fragment>', FACADE_MAIN)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = fRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = fMetal;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(fNW, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', FACADE_NIGHT);
    patchBuildingFog(shader, bu);
  };
  mat.customProgramCacheKey = () => FACADE_PROGRAM;
  return mat;
}

/** Every texture a facade material samples (for anisotropy per tier). */
export function facadeTexturesOf(mat: THREE.MeshStandardMaterial): THREE.Texture[] {
  const out = [mat.map, mat.normalMap, mat.roughnessMap, mat.emissiveMap, (mat.userData.facade as { glass?: THREE.Texture } | undefined)?.glass];
  return out.filter((t): t is THREE.Texture => !!t);
}
