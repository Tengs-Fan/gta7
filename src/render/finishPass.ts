// The last effect on every hardware tier: optional FXAA, then the colour grade and vignette, all in
// linear HDR. three's own output pass applies ACES and sRGB afterwards, so the colour pipeline is the
// same on every tier.

import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import type { Grade } from './grade';

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

		const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );

		vec3 Grade( vec3 c, vec2 uv ) {
			c *= uTint / dot( uTint, LUMA );
			float L = dot( c, LUMA );
			c = max( mix( vec3( L ), c, uSat ), 0.0 );
			c = 0.18 * pow( max( c, 1e-6 ) / 0.18, vec3( uContrast ) );
			float k = smoothstep( -2.5, 2.5, log2( max( dot( c, LUMA ), 1e-6 ) / 0.18 ) );
			vec3 tone = mix( vec3( 0.92, 0.98, 1.1 ), vec3( 1.08, 1.0, 0.9 ), k );
			c *= mix( vec3( 1.0 ), tone / dot( tone, LUMA ), uSplit );
			// Night black level: a cool grey floor that lifts what the ACES toe would crush (uLift, 0 by day).
			c += uLift * vec3( 0.92, 0.98, 1.1 );
			vec2 q = uv - 0.5;
			c *= 1.0 - uVignette * smoothstep( 0.35, 1.0, dot( q, q ) * 2.0 );
			return c;
		}

		void main() {
			vec4 col;
			if ( uFxaa > 0.5 ) col = ApplyFXAA( tDiffuse, resolution.xy, vUv );
			else col = texture( tDiffuse, vUv );
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
