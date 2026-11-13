// The last effect on every hardware tier: optional FXAA, then the colour grade and vignette, all in
// linear HDR. three's own output pass applies ACES and sRGB afterwards, so the colour pipeline is the
// same on every tier.

import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { smoothstep } from '../core/math';
import type { Grade } from './grade';

/** How hard the frame streaks (FinishPass.rush, 0..1) in a car at `speed` m/s: nothing under 90 km/h, full from 205 km/h. */
export function rushAt(speed: number): number {
  return smoothstep(25, 57, Math.abs(speed));
}

const LUMA_FIND = 'float SampleLuminance( sampler2D tex2D, vec2 uv ) {\n\n\t\t\treturn dot( Sample( tex2D, uv ).rgb, vec3( 0.3, 0.59, 0.11 ) );';
// FXAA expects display-referred input. P maps HDR into [0,1) reversibly (Pinv), so edges against
// bright lamps are found and blended as they will look after tone mapping, without clamping HDR.
const LUMA_REPLACE = [
  'vec3 P( vec3 c ) { return c / ( 1.0 + max( max( c.r, c.g ), c.b ) ); }',
  '\t\tvec3 Pinv( vec3 c ) { return c / max( 1.0 - max( max( c.r, c.g ), c.b ), 1e-4 ); }',
  '\t\tfloat SampleLuminance( sampler2D tex2D, vec2 uv ) {\n\n\t\t\treturn sqrt( dot( P( Sample( tex2D, uv ).rgb ), vec3( 0.3, 0.59, 0.11 ) ) );',
].join('\n');
const BLEND_FIND = /if \(edge.isHorizontal\) \{\s*uv.y \+= edge.pixelStep \* finalBlend;\s*\} else \{\s*uv.x \+= edge.pixelStep \* finalBlend;\s*\}\s*return Sample\( tex2D, uv \);/;
// A bilinear UV shift would mix raw HDR texels; blend two taps in proxy space instead.
const BLEND_REPLACE = [
  'vec2 o = edge.isHorizontal ? vec2( 0.0, edge.pixelStep ) : vec2( edge.pixelStep, 0.0 );',
  '\t\t\tvec4 a = Sample( tex2D, uv ); vec4 b = Sample( tex2D, uv + o );',
  '\t\t\treturn vec4( Pinv( mix( P( a.rgb ), P( b.rgb ), finalBlend ) ), a.a );',
].join('\n');
const MAIN_FIND = /void main\(\) \{\s*gl_FragColor = ApplyFXAA\( tDiffuse, resolution\.xy, vUv \);\s*\}/;

const GRADE = /* glsl */ `
		uniform float uFxaa;
		uniform float uGrade;
		uniform vec3 uTint;
		uniform float uSat;
		uniform float uContrast;
		uniform float uVignette;
		uniform float uSplit;
		uniform float uLift;
		uniform float uRush;
		uniform int uRushTaps;

		const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );

		vec3 Grade( vec3 c, vec2 uv ) {
			c *= uTint / dot( uTint, LUMA );
			float L = dot( c, LUMA );
			c = max( mix( vec3( L ), c, uSat ), 0.0 );
			c = 0.18 * pow( max( c, 1e-6 ) / 0.18, vec3( uContrast ) );
			float k = smoothstep( -2.5, 2.5, log2( max( dot( c, LUMA ), 1e-6 ) / 0.18 ) );
			vec3 tone = mix( vec3( 0.92, 0.98, 1.1 ), vec3( 1.08, 1.0, 0.9 ), k );
			c *= mix( vec3( 1.0 ), tone / dot( tone, LUMA ), uSplit );
			// Night black level: a cool grey floor under what the ACES toe would crush (uLift, 0 by day). It fades out
			// above a few times the lift, so lit facades and the sky keep their brightness (and the curve stays monotonic).
			c += uLift * vec3( 0.92, 0.98, 1.1 ) * exp( - dot( c, LUMA ) / max( 3.0 * uLift, 1e-6 ) );
			vec2 q = uv - 0.5;
			c *= 1.0 - uVignette * smoothstep( 0.35, 1.0, dot( q, q ) * 2.0 );
			return c;
		}

		// The rush of speed (uRush, 0 off .. 1): the frame streaks towards the point the road runs to, just above its
		// centre; not at all in the tall oval that holds the car and the street it is aimed down, and most at the edges.
		// uRushTaps taps along the streak (ten on High, five on Medium, whose integrated GPUs paid 3 fps for ten),
		// started at a per-pixel offset so that their spacing shows as grain, not as ghosts.
		vec3 Rush( vec3 c, vec2 uv ) {
			vec2 q = uv - vec2( 0.5, 0.56 );
			float reach = uRush * 0.11 * smoothstep( 0.17, 0.62, length( ( uv - vec2( 0.5, 0.4 ) ) * vec2( 1.0, 0.7 ) ) );
			if ( reach < 0.0008 ) return c;
			float n = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
			vec3 sum = c;
			float taps = float( uRushTaps );
			for ( int i = 0; i < uRushTaps; i ++ ) sum += texture( tDiffuse, uv - q * reach * ( float( i ) + n ) / taps ).rgb;
			return sum / ( taps + 1.0 );
		}

		void main() {
			vec4 col;
			if ( uFxaa > 0.5 ) col = ApplyFXAA( tDiffuse, resolution.xy, vUv );
			else col = texture( tDiffuse, vUv );
			if ( uRush > 0.004 ) col.rgb = Rush( col.rgb, vUv );
			if ( uGrade > 0.5 ) col.rgb = Grade( col.rgb, vUv );
			gl_FragColor = col;
		}`;

function replaceOnce(src: string, find: string | RegExp, replace: string, what: string): string {
  const matched = typeof find === 'string' ? src.includes(find) : find.test(src);
  if (!matched) throw new Error(`FinishPass: the FXAA shader patch (${what}) no longer applies; check three's FXAAShader`);
  return src.replace(find, () => replace);
}

/** FXAAShader's fragment shader with the proxy-space luminance and resolve, and FinishPass's main(). */
export function patchFxaa(fs: string): string {
  fs = replaceOnce(fs, LUMA_FIND, LUMA_REPLACE, 'luminance');
  fs = replaceOnce(fs, BLEND_FIND, BLEND_REPLACE, 'blend');
  return replaceOnce(fs, MAIN_FIND, GRADE, 'main');
}

// Patched at module load so a three upgrade that changes FXAAShader fails loudly at once.
export const finishFragmentShader = patchFxaa(FXAAShader.fragmentShader);

export class FinishPass extends Pass {
  readonly material: THREE.ShaderMaterial;
  /** When set, replaces the grade's vignette (debug hook). */
  vignetteOverride: number | null = null;
  private readonly quad: FullScreenQuad;

  constructor() {
    super();
    this.material = new THREE.ShaderMaterial({
      name: 'FinishPass',
      uniforms: {
        tDiffuse: { value: null },
        resolution: { value: new THREE.Vector2(1 / 1024, 1 / 512) },
        uFxaa: { value: 0 },
        uGrade: { value: 1 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uSat: { value: 1 },
        uContrast: { value: 1 },
        uVignette: { value: 0 },
        uSplit: { value: 0 },
        uLift: { value: 0 },
        uRush: { value: 0 },
        uRushTaps: { value: 10 },
      },
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: finishFragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  get fxaa(): boolean {
    return this.material.uniforms.uFxaa!.value > 0.5;
  }

  set fxaa(on: boolean) {
    this.material.uniforms.uFxaa!.value = on ? 1 : 0;
  }

  get grade(): boolean {
    return this.material.uniforms.uGrade!.value > 0.5;
  }

  set grade(on: boolean) {
    this.material.uniforms.uGrade!.value = on ? 1 : 0;
  }

  /** The rush of speed, 0 (off) to 1: how far the edges of the frame streak towards its centre (see Rush in the shader). */
  get rush(): number {
    return this.material.uniforms.uRush!.value as number;
  }

  set rush(k: number) {
    this.material.uniforms.uRush!.value = Math.min(1, Math.max(0, k));
  }

  /** How many samples the rush of speed takes along each streak (see Rush in the shader). */
  set rushTaps(n: number) {
    this.material.uniforms.uRushTaps!.value = Math.max(1, Math.round(n));
  }

  setGrade(g: Readonly<Grade>): void {
    const u = this.material.uniforms;
    (u.uTint!.value as THREE.Vector3).set(g.tint[0], g.tint[1], g.tint[2]);
    u.uSat!.value = g.sat;
    u.uContrast!.value = g.contrast;
    u.uVignette!.value = this.vignetteOverride ?? g.vignette;
    u.uSplit!.value = g.splitTone;
    u.uLift!.value = g.lift;
  }

  override setSize(width: number, height: number): void {
    (this.material.uniforms.resolution!.value as THREE.Vector2).set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.material.uniforms.tDiffuse!.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
