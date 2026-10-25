// The burnt-out wreck material shared by car, bike and boat wrecks: soot and char with patches of heat-blued bare metal
// and rust, from 3D noise of the model-space position (no UVs needed, the same on the near body, its dents and the far
// batches). Bare metal is shinier and metallic; char is rough. On the software tier the same colour patch runs in the
// vertex-lit stand-in (SoftwareMaterials calls this onBeforeCompile), without the metalness part.

import * as THREE from 'three';

const PARS_VERTEX = /* glsl */ `
varying vec3 vBurntPos;`;

const PARS_FRAGMENT = /* glsl */ `
varying vec3 vBurntPos;
float burntHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float burntNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(burntHash(i), burntHash(i + vec3(1, 0, 0)), f.x), mix(burntHash(i + vec3(0, 1, 0)), burntHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(burntHash(i + vec3(0, 0, 1)), burntHash(i + vec3(1, 0, 1)), f.x), mix(burntHash(i + vec3(0, 1, 1)), burntHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float burntBare = 0.0;`;

const COLOR = /* glsl */ `
{
  vec3 bp = vBurntPos;
  float big = burntNoise(bp * 3.1);
  float mid = burntNoise(bp * 7.9 + 7.1);
  float fine = burntNoise(bp * 23.0 + 3.7);
  // Char eats the panels; bare, heat-dulled metal shows through in flaking patches, with a little rust at their edges.
  float flake = big * 0.55 + mid * 0.3 + fine * 0.15;
  float bare = smoothstep(0.6, 0.7, flake);
  float rust = smoothstep(0.5, 0.6, flake) * (1.0 - bare) * 0.45;
  vec3 charCol = mix(vec3(0.014, 0.013, 0.012), vec3(0.05, 0.047, 0.044), fine);
  vec3 soot = mix(charCol, vec3(0.085, 0.082, 0.078), smoothstep(0.3, 0.8, mid) * 0.75);
  vec3 metal = mix(vec3(0.17, 0.165, 0.16), vec3(0.26, 0.25, 0.24), fine);
  vec3 rustCol = mix(vec3(0.11, 0.06, 0.035), vec3(0.16, 0.085, 0.045), fine);
  vec3 c = mix(soot, rustCol, rust);
  c = mix(c, metal, bare);
  diffuseColor.rgb = c;
  burntBare = bare;
}`;

const ROUGHNESS = /* glsl */ `
roughnessFactor = mix(0.95, 0.45, burntBare);`;

const METALNESS = /* glsl */ `
metalnessFactor = mix(0.05, 0.75, burntBare);`;

/** Patches a standard (or, on software, Lambert) shader into the burnt look. */
export function burntPatch(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>${PARS_VERTEX}`)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBurntPos = position;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>${PARS_FRAGMENT}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${COLOR}`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${ROUGHNESS}`)
    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${METALNESS}`);
}

let shared: THREE.MeshStandardMaterial | null = null;

/** The one burnt-wreck material (shared by every wreck: one program family). */
export function burntMaterial(): THREE.MeshStandardMaterial {
  if (shared) return shared;
  // The base colour is a char tone: batched plain parts (rims, lamps, livery: vehicleBatches isPlainPart) draw with it
  // through the shared parts material, without the patch; the bodies draw the patch over it.
  const m = new THREE.MeshStandardMaterial({ color: 0x2b2826, roughness: 0.9, metalness: 0.1 });
  m.name = 'wreck-burnt';
  m.onBeforeCompile = burntPatch;
  m.customProgramCacheKey = () => 'wreck-burnt-v1';
  shared = m;
  return m;
}
