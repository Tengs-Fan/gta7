// What is painted on the people rather than modelled: collars, plackets and buttons, pockets, a jacket's lapels and
// the shirt under it, belts and buckles, the stitching of jeans, a cap's panels, cuffs and an officer's shoulder patch,
// brows, lips and beards. Each is worked out per pixel from where it falls on the part (its own coordinates, after a
// woman's blend) and the person's second colour and style (CrowdView: `instanceTrim`, `instanceStyle`), so it costs
// no triangles, no texture and no draw call, and it stays sharp at two metres where a 14-sided torso has no vertex to
// hang a seam on. Lines fade to their average where they are thinner than a pixel, so a street's crowd does not crawl.
//
// Every snippet reads `base` (the part's colour as the instance and its vertex colours make it), `p` (the point on
// the part), `front` and `behind` (0..1, which side of the part it is on), vTrim and vStyle, and writes `col`.
import type { CharacterPartName } from './characterGeometry';

/** The common declarations: a filled shape from a signed distance, a line about a distance, a box's signed distance. */
const HELPERS = /* glsl */ `
varying vec3 vObj;
varying vec3 vTrim;
varying vec4 vStyle;
float pxFill( float sd ) {
  float f = max( fwidth( sd ), 1e-5 );
  return clamp( 0.5 - sd / f, 0.0, 1.0 );
}
float pxLine( float d, float w ) {
  float f = max( fwidth( d ), 1e-5 );
  return clamp( 0.5 + ( w - abs( d ) ) / f, 0.0, 1.0 ) * clamp( 2.0 * w / f, 0.0, 1.0 );
}
float pxBox( vec2 p, vec2 c, vec2 h ) {
  vec2 d = abs( p - c ) - h;
  return length( max( d, 0.0 ) ) + min( max( d.x, d.y ), 0.0 );
}
vec3 pxSeam( vec3 b ) {
  return dot( b, vec3( 0.3, 0.59, 0.11 ) ) < 0.05 ? b * 1.9 + 0.022 : b * 0.62;
}
float pxSegment( vec2 p, vec2 a, vec2 b ) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length( pa - ba * clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 ) );
}`;

/**
 * Tops (torso and the hem of an untucked one), by vStyle.x: 0 a tee with a ribbed crew neck; 1 a V neck, the skin
 * (vTrim) in it; 2 a shirt with a placket, buttons and a breast pocket (its collar is a part); 3 a uniform shirt, two
 * flapped pockets and epaulettes; 4 an open jacket over a shirt (vTrim) with lapels, zipped (vStyle.y 1) or buttoned
 * below them, welt pockets, a yoke and a centre seam behind.
 * Heights in the torso's frame: the collar ring at 0.648 m over the hip joints, the chest at 0.4 to 0.5.
 */
const TOP = /* glsl */ `
float top = vStyle.x;
float neck = length( vec2( p.x, p.z * 1.2 ) );
float crew = pxFill( neck - 0.097 ) * step( 0.6, p.y );
if ( top < 0.5 ) {
  col = mix( col, base * 0.74, crew );
} else if ( top < 1.5 ) {
  float v = p.y - ( 0.54 + 1.9 * abs( p.x ) );
  col = mix( col, base * 0.74, crew * ( 1.0 - front ) );
  col = mix( col, base * 0.72, pxLine( v + 0.007, 0.006 ) * front );
  col = mix( col, vTrim, pxFill( -v ) * front );
} else if ( top < 3.5 ) {
  float below = step( p.y, 0.615 );
  float pl = abs( p.x ) - 0.014;
  col = mix( col, base * 0.9, pxFill( pl ) * front * below );
  col = mix( col, base * 0.66, pxLine( pl, 0.0016 ) * front * below );
  float by = mod( p.y - 0.008, 0.068 ) - 0.034;
  float button = pxFill( length( vec2( p.x, by ) ) - 0.0058 ) * front * step( p.y, 0.59 );
  col = mix( col, mix( base, vec3( 0.82, 0.8, 0.74 ), 0.6 ), button );
  float worn = step( 2.5, top );
  float side = mix( p.x, abs( p.x ), worn );
  float pocket = pxBox( vec2( side, p.y ), vec2( 0.078, 0.425 ), vec2( 0.036, 0.042 ) );
  col = mix( col, base * 0.66, pxLine( pocket, 0.0018 ) * front * step( p.z, 0.2 ) );
  float flap = pxBox( vec2( side, p.y ), vec2( 0.078, 0.459 ), vec2( 0.039, 0.013 ) );
  col = mix( col, base * 0.8, pxFill( flap ) * front * worn );
  col = mix( col, base * 0.58, pxLine( flap, 0.0016 ) * front * worn );
  float epaulette = pxFill( abs( p.z ) - 0.021 ) * step( 0.085, abs( p.x ) ) * step( 0.55, p.y );
  col = mix( col, base * 0.7, epaulette * worn );
  col = mix( col, base * 0.66, pxLine( p.y - 0.535 + 0.25 * p.x * p.x, 0.0018 ) * behind );
} else {
  float w = mix( 0.008, 0.08, clamp( ( p.y - 0.37 ) / 0.27, 0.0, 1.0 ) );
  float open = abs( p.x ) - w;
  float upper = step( 0.37, p.y );
  vec3 inner = mix( vTrim, vTrim * 0.76, crew );
  col = mix( col, base * 1.14 + 0.015, pxFill( open - 0.03 ) * front * step( 0.45, p.y ) );
  col = mix( col, base * 0.5, pxLine( open - 0.03, 0.0016 ) * front * step( 0.45, p.y ) * step( 0.0, open ) );
  col = mix( col, inner, pxFill( open ) * front * upper );
  col = mix( col, base * 0.45, pxLine( open, 0.0022 ) * front * upper );
  if ( vStyle.y > 0.5 ) {
    col = mix( col, vec3( 0.6, 0.6, 0.58 ), pxLine( p.x, 0.0024 ) * front * ( 1.0 - upper ) );
  } else {
    float by = mod( p.y - 0.03, 0.085 ) - 0.0425;
    col = mix( col, base * 0.45, pxFill( length( vec2( p.x - 0.006, by ) ) - 0.0068 ) * front * ( 1.0 - upper ) * step( 0.1, p.y ) );
  }
  float welt = p.y - 0.2 + 0.12 * ( abs( p.x ) - 0.09 );
  col = mix( col, pxSeam( base ), pxLine( welt, 0.0024 ) * front * step( 0.05, abs( p.x ) ) * step( abs( p.x ), 0.135 ) );
  col = mix( col, pxSeam( base ), pxLine( p.y - 0.47, 0.0022 ) * behind );
  col = mix( col, pxSeam( base ), pxLine( p.x, 0.002 ) * behind * step( p.y, 0.47 ) );
  col = mix( col, pxSeam( base ), pxLine( abs( p.x ) - 0.105 + 0.15 * ( 0.47 - p.y ), 0.0018 ) * behind * step( p.y, 0.47 ) * step( 0.12, p.y ) );
}`;

/**
 * Trousers: the waistband, or a belt (vStyle.x 1, in vTrim) with a buckle and the trousers' loops over it; the fly,
 * slant pockets in front and patch pockets behind; jeans (vStyle.y 1) stitched in a gold thread, with a yoke behind.
 * Heights in the hips' frame: the belt from 0.068 to 0.095 m over the hip joints.
 */
const TROUSERS = /* glsl */ `
float jeans = vStyle.y;
vec3 thread = mix( base * 0.6, mix( base, vec3( 0.66, 0.46, 0.22 ), 0.75 ), jeans );
float band = step( 0.068, p.y ) * step( p.y, 0.095 );
float ax = abs( p.x );
col = mix( col, mix( base * 0.84, vTrim, vStyle.x ), band );
col = mix( col, base * 0.55, ( pxLine( p.y - 0.068, 0.0012 ) + pxLine( p.y - 0.095, 0.0012 ) ) * ( 1.0 - vStyle.x ) );
float loops = pxFill( abs( ax - 0.082 ) - 0.0055 ) + pxFill( ax - 0.0055 ) * behind;
col = mix( col, base * 0.92, clamp( loops, 0.0, 1.0 ) * band * vStyle.x );
float buckle = pxBox( p.xy, vec2( 0.0, 0.0815 ), vec2( 0.018, 0.0125 ) );
col = mix( col, vec3( 0.72, 0.69, 0.6 ), pxFill( buckle ) * front * vStyle.x );
col = mix( col, vTrim * 0.7, pxFill( buckle + 0.005 ) * front * vStyle.x );
float below = step( p.y, 0.066 );
float fly = min( pxSegment( p.xy, vec2( 0.022, 0.064 ), vec2( 0.022, 0.0 ) ), pxSegment( p.xy, vec2( 0.022, 0.0 ), vec2( 0.0, -0.032 ) ) );
col = mix( col, thread, pxLine( fly, 0.0014 ) * front );
col = mix( col, base * 0.55, pxLine( p.x, 0.0014 ) * front * below );
float slant = pxSegment( vec2( ax, p.y ), vec2( 0.108, 0.066 ), vec2( 0.162, -0.008 ) );
col = mix( col, base * 0.5, pxLine( slant, 0.0016 ) * front );
col = mix( col, thread, pxLine( slant - 0.006, 0.0011 ) * front * jeans );
float pocket = pxBox( vec2( ax, p.y ), vec2( 0.074, 0.008 ), vec2( 0.04, 0.036 ) );
pocket = max( pocket, ( p.y + 0.012 ) * 0.6 - ( 0.04 - abs( ax - 0.074 ) ) * 0.45 - 0.004 );
col = mix( col, pxSeam( base ), pxLine( pocket, 0.0015 ) * behind * below );
col = mix( col, thread, pxLine( pocket + 0.005, 0.0011 ) * behind * below * jeans );
col = mix( col, thread, pxLine( p.y - 0.044 + 0.17 * ( 0.17 - ax ), 0.0011 ) * behind * below * jeans );
col = mix( col, base * 0.55, pxLine( p.x, 0.0014 ) * behind * below );`;

/** A cap: six panels meeting at a button on the crown, a sweatband and the shade under its bill. */
const CAP = /* glsl */ `
float a = atan( p.x, p.z );
float r = length( p.xz );
float seam = ( fract( a * 0.9549297 + 0.5 ) - 0.5 ) * 1.0471976 * r;
col = mix( col, base * 0.62, pxLine( seam, 0.0014 ) * step( 0.29, p.y ) * step( p.y, 0.356 ) );
col = mix( col, base * 0.6, step( 0.355, p.y ) );
col = mix( col, base * 0.55, pxLine( p.y - 0.29, 0.0014 ) * step( p.z, 0.08 ) );
col = mix( col, base * 0.5, step( p.y, 0.27 ) * step( 0.128, p.z ) );`;

/**
 * Sleeves and arms, by vStyle.x 1 for cloth (bare arms are not painted): a cuff at the wrist; and on an officer
 * (vStyle.z 1) a patch in vTrim on the outside of the upper arm (vStyle.y: which side is out, 1 the left arm).
 */
const FOREARM = /* glsl */ `
float cuff = step( p.y, -0.226 ) * vStyle.x;
col = mix( col, base * 0.78, cuff );
col = mix( col, base * 0.55, pxLine( p.y + 0.226, 0.0014 ) * vStyle.x );`;
const UPPER_ARM = /* glsl */ `
float outside = step( 0.012, p.x * vStyle.y );
float mark = length( vec2( p.z / 0.027, ( p.y + 0.088 ) / 0.035 ) ) - 1.0;
col = mix( col, vTrim, pxFill( mark * 0.03 ) * outside * vStyle.z );
col = mix( col, vec3( 0.75, 0.62, 0.3 ), pxLine( mark * 0.03, 0.0016 ) * outside * vStyle.z );`;

/** The sole and heel in the second colour (the shoe's `trimMask` vertices), the upper in the first. */
const SHOE = /* glsl */ `
col = mix( col, vSecond, vTrimMask );`;

/** Which parts are painted, and how. */
export const PAINT: Partial<Record<CharacterPartName, string>> = {
  torso: TOP,
  hem: TOP,
  hips: TROUSERS,
  hat: CAP,
  forearm: FOREARM,
  upperArm: UPPER_ARM,
  shoe: SHOE,
};

/**
 * Adds a part's paint to a crowd material's shader (after its fade and shape patches): the point on the part, the
 * second colour and the style pass to the fragment, where the snippet recolours the diffuse colour as the instance and
 * vertex colours made it. `masked`: the part's geometry carries `trimMask`, the share of the second colour at each
 * vertex (a shoe's sole), which follows the vertex colours' shading.
 */
export function paintShader(shader: { vertexShader: string; fragmentShader: string }, glsl: string, masked: boolean): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
attribute vec3 instanceTrim;
attribute vec4 instanceStyle;
varying vec3 vObj;
varying vec3 vTrim;
varying vec4 vStyle;${masked ? '\nattribute float trimMask;\nvarying float vTrimMask;\nvarying vec3 vSecond;' : ''}`,
    )
    .replace(
      '#include <project_vertex>',
      `vObj = transformed;
vTrim = instanceTrim;
vStyle = instanceStyle;${masked ? '\nvTrimMask = trimMask;\nvSecond = instanceTrim * color.rgb;' : ''}
#include <project_vertex>`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>${HELPERS}${masked ? '\nvarying float vTrimMask;\nvarying vec3 vSecond;' : ''}`)
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
{
  vec3 base = diffuseColor.rgb;
  vec3 col = base;
  vec3 p = vObj;
  float front = smoothstep( 0.0, 0.03, p.z );
  float behind = 1.0 - smoothstep( -0.03, 0.0, p.z );
${glsl}
  diffuseColor.rgb = col;
}`,
    );
}
