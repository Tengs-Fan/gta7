// Shader patches of the skinned characters, shared by the near SkinnedMesh pool (three's skinning, the character's
// data in its own bone texture) and the batched crowd (one BatchedMesh draw; every character's bones and data in one
// float texture, found by the instance id). Both read two data matrices after the rig's bones (rig.ts writeData): the
// fade, the near-lens flag and the outfit colours, so per-character looks and fades need no extra draws or materials.
import * as THREE from 'three';
import { LENS_FADE_FULL, LENS_FADE_GONE } from './fade';
import { BONES_PER_CHAR, RIG_BONES } from './rig';

const DATA = RIG_BONES.toFixed(1);
const DATA2 = (RIG_BONES + 1).toFixed(1);

const VERTEX_COMMON = /* glsl */ `
attribute float slot;
varying float vCharFade;
varying float vCharLens;
#ifdef USE_BATCHING
attribute vec4 skinIndex;
attribute vec4 skinWeight;
uniform highp sampler2D crowdBones;
mat4 crowdBone( const in float inst, const in float j ) {
  int size = textureSize( crowdBones, 0 ).x;
  int k = int( inst ) * ${BONES_PER_CHAR * 4} + int( j ) * 4;
  int x = k % size;
  int y = k / size;
  return mat4( texelFetch( crowdBones, ivec2( x, y ), 0 ), texelFetch( crowdBones, ivec2( x + 1, y ), 0 ),
    texelFetch( crowdBones, ivec2( x + 2, y ), 0 ), texelFetch( crowdBones, ivec2( x + 3, y ), 0 ) );
}
#define CHAR_INST getIndirectIndex( gl_DrawID )
#define CHAR_BONE( i, j ) crowdBone( i, j )
#else
#define CHAR_INST 0.0
#define CHAR_BONE( i, j ) getBoneMatrix( j )
#endif
`;

const BAYER = /* glsl */ `
float lensBayer4( vec2 frag ) {
  const float m[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
  ivec2 p = ivec2( mod( floor( frag ), 4.0 ) );
  return ( m[ p.x + p.y * 4 ] + 0.5 ) / 16.0;
}`;

const BATCHED_SKIN_BASE = /* glsl */ `
#ifdef USE_BATCHING
  float charInst = CHAR_INST;
  mat4 boneMatX = crowdBone( charInst, skinIndex.x );
  mat4 boneMatY = crowdBone( charInst, skinIndex.y );
  mat4 boneMatZ = crowdBone( charInst, skinIndex.z );
  mat4 boneMatW = crowdBone( charInst, skinIndex.w );
#else
#include <skinbase_vertex>
#endif`;

const BATCHED_SKIN_NORMAL = /* glsl */ `
#ifdef USE_BATCHING
  mat4 charSkin = skinWeight.x * boneMatX + skinWeight.y * boneMatY + skinWeight.z * boneMatZ + skinWeight.w * boneMatW;
  objectNormal = vec4( charSkin * vec4( objectNormal, 0.0 ) ).xyz;
#else
#include <skinnormal_vertex>
#endif`;

const BATCHED_SKINNING = /* glsl */ `
#ifdef USE_BATCHING
  {
    vec4 sv = vec4( transformed, 1.0 );
    vec4 skinned = boneMatX * sv * skinWeight.x + boneMatY * sv * skinWeight.y + boneMatZ * sv * skinWeight.z + boneMatW * sv * skinWeight.w;
    transformed = skinned.xyz;
  }
#else
#include <skinning_vertex>
#endif`;

function replaceOnce(src: string, find: string, by: string): string {
  if (!src.includes(find)) throw new Error(`character shader: ${find} not found`);
  return src.replace(find, by);
}

/** Batched skinning (no-op for SkinnedMesh, which three skins) and the character data read in the vertex shader. */
function vertex(shader: THREE.WebGLProgramParametersWithUniforms, colors: boolean): void {
  let v = replaceOnce(shader.vertexShader, '#include <common>', `#include <common>\n${VERTEX_COMMON}`);
  v = replaceOnce(v, '#include <skinbase_vertex>', BATCHED_SKIN_BASE);
  if (v.includes('#include <skinnormal_vertex>')) v = v.replace('#include <skinnormal_vertex>', BATCHED_SKIN_NORMAL);
  v = replaceOnce(v, '#include <skinning_vertex>', BATCHED_SKINNING);
  const read = /* glsl */ `
  {
    mat4 d0 = CHAR_BONE( CHAR_INST, ${DATA} );
    vCharFade = d0[ 0 ].x;
    vCharLens = d0[ 0 ].y;
${colors ? `    mat4 d1 = CHAR_BONE( CHAR_INST, ${DATA2} );
    int s = int( slot + 0.5 );
    vec3 slotCol = s == 1 ? d0[ 1 ].rgb : s == 2 ? d0[ 2 ].rgb : s == 3 ? d0[ 3 ].rgb : s == 4 ? d1[ 0 ].rgb : s == 5 ? d1[ 1 ].rgb : s == 6 ? d1[ 2 ].rgb : s == 7 ? d1[ 3 ].rgb : vec3( 1.0 );
    vColor.rgb *= slotCol;` : ''}
  }`;
  v = colors ? replaceOnce(v, '#include <color_vertex>', `#include <color_vertex>\n${read}`) : replaceOnce(v, '#include <begin_vertex>', `#include <begin_vertex>\n${read}`);
  shader.vertexShader = v;
}

function fragment(shader: THREE.WebGLProgramParametersWithUniforms, lens: boolean): void {
  let f = replaceOnce(shader.fragmentShader, '#include <common>', `#include <common>\nvarying float vCharFade;\nvarying float vCharLens;\n${BAYER}`);
  f = replaceOnce(f, '#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if ( vCharFade < 1.0 && lensBayer4( gl_FragCoord.xy ) >= vCharFade ) discard;
${lens ? `if ( vCharLens > 0.5 && vViewPosition.z < ${LENS_FADE_FULL.toFixed(2)} && lensBayer4( gl_FragCoord.xy ) >= smoothstep( ${LENS_FADE_GONE.toFixed(2)}, ${LENS_FADE_FULL.toFixed(2)}, vViewPosition.z ) ) discard;` : ''}`);
  shader.fragmentShader = f;
}

/** The crowd texture uniform, shared by the batched materials (set by SkinnedCrowd). */
export const crowdUniforms = { crowdBones: { value: null as THREE.Texture | null } };

function charMain(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.crowdBones = crowdUniforms.crowdBones;
  vertex(shader, true);
  fragment(shader, true);
}

function charDepth(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.crowdBones = crowdUniforms.crowdBones;
  vertex(shader, false);
  fragment(shader, false);
}

/** The skinned characters' surface: vertex colours times the slot colour, dithered fades and the near-lens dissolve. */
export function characterMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0, vertexColors: true });
  m.onBeforeCompile = charMain;
  m.customProgramCacheKey = () => 'gta7-character-skin';
  m.userData.contactShadow = false;
  m.name = 'character-skin';
  return m;
}

/** Their shadow: the fade dithered into the shadow map, no lens dissolve (a player dissolved by the camera keeps it). */
export function characterDepthMaterial(): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = charDepth;
  m.customProgramCacheKey = () => 'gta7-character-skin-depth';
  m.name = 'character-skin-depth';
  return m;
}
