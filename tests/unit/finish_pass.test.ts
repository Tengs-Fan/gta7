// FinishPass (src/render/finishPass.ts): the patched proxy FXAA, the grade uniforms and the pass contract
// three's setEffects relies on (setSize in drawing-buffer pixels, read readBuffer, write writeBuffer).

import * as THREE from 'three';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { describe, expect, it } from 'vitest';
import { FinishPass, finishFragmentShader, patchFxaa } from '../../src/render/finishPass';
import { gradeAt } from '../../src/render/grade';

describe('FinishPass', () => {
  it('loads with both FXAA patches applied', () => {
    const pass = new FinishPass();
    const fs = pass.material.fragmentShader;
    expect(fs).toContain('Pinv( mix');
    expect(fs).toContain('sqrt( dot( P( Sample( tex2D, uv ).rgb )');
    expect(fs).not.toMatch(/uv\.y \+= edge\.pixelStep \* finalBlend/);
    expect(fs).toContain('uniform float uFxaa');
    expect(fs).toContain('uniform vec3 uTint');
    expect(fs).toBe(finishFragmentShader);
    pass.dispose();
  });

  it('throws if the FXAA shader no longer matches the patch', () => {
    expect(() => patchFxaa(FXAAShader.fragmentShader.replace('vec3( 0.3, 0.59, 0.11 )', 'vec3( 0.3, 0.6, 0.1 )'))).toThrow(/FXAA/);
    expect(() => patchFxaa(FXAAShader.fragmentShader.replace('uv.y += edge.pixelStep * finalBlend;', 'uv.y += edge.pixelStep * finalBlend * 1.0;'))).toThrow(/FXAA/);
    expect(() => patchFxaa(FXAAShader.fragmentShader.replace('gl_FragColor = ApplyFXAA', 'gl_FragColor = 0.5 * ApplyFXAA'))).toThrow(/FXAA/);
  });

  it('setSize sets the texel size from drawing-buffer pixels', () => {
    const pass = new FinishPass();
    pass.setSize(1280, 720);
    const res = pass.material.uniforms.resolution!.value as THREE.Vector2;
    expect(res.x).toBeCloseTo(1 / 1280, 12);
    expect(res.y).toBeCloseTo(1 / 720, 12);
    pass.dispose();
  });

  it('render reads readBuffer.texture and writes writeBuffer', () => {
    const pass = new FinishPass();
    expect(pass.needsSwap).toBe(true);
    const read = new THREE.WebGLRenderTarget(4, 4);
    const write = new THREE.WebGLRenderTarget(4, 4);
    const targets: unknown[] = [];
    const drawn: unknown[] = [];
    const renderer = {
      setRenderTarget: (t: unknown) => targets.push(t),
      render: (o: unknown) => drawn.push(o),
    } as unknown as THREE.WebGLRenderer;
    pass.render(renderer, write, read);
    expect(pass.material.uniforms.tDiffuse!.value).toBe(read.texture);
    expect(targets).toEqual([write]);
    expect(drawn.length).toBe(1);
    expect((drawn[0] as THREE.Mesh).material).toBe(pass.material);
    pass.dispose();
  });

  it('drives FXAA, the grade and the vignette through uniforms only', () => {
    const pass = new FinishPass();
    const u = pass.material.uniforms;
    const program = pass.material.fragmentShader;
    expect(pass.fxaa).toBe(false);
    pass.fxaa = true;
    expect(u.uFxaa!.value).toBe(1);
    const g = gradeAt(18.4);
    pass.setGrade(g);
    expect((u.uTint!.value as THREE.Vector3).toArray()).toEqual(g.tint);
    expect(u.uSat!.value).toBe(g.sat);
    expect(u.uContrast!.value).toBe(g.contrast);
    expect(u.uVignette!.value).toBe(g.vignette);
    expect(u.uSplit!.value).toBe(g.splitTone);
    expect(u.uGrade!.value).toBe(1);
    pass.vignetteOverride = 0;
    pass.setGrade(g);
    expect(u.uVignette!.value).toBe(0);
    pass.grade = false;
    expect(u.uGrade!.value).toBe(0);
    expect(pass.material.fragmentShader).toBe(program);
    pass.dispose();
  });
});
