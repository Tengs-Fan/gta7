import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContactShadows } from '../../src/render/contactShadows';

afterEach(() => vi.restoreAllMocks());

describe('contact shadow scene isolation', () => {
  it('releases the occlusion and blending shaders when changing quality', () => {
    const pass = new ContactShadows(new THREE.Scene(), new THREE.PerspectiveCamera());
    const ao = vi.spyOn(pass.gtaoMaterial, 'dispose');
    const blend = vi.spyOn(pass.blendMaterial, 'dispose');
    pass.dispose();
    expect(ao).toHaveBeenCalledOnce();
    expect(blend).toHaveBeenCalledOnce();
  });

  it.each([false, true])('keeps glass and light pools out of depth and restores scene state (error=%s)', (fail) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x123456);
    const background = scene.background;
    const override = new THREE.MeshBasicMaterial();
    scene.overrideMaterial = override;
    const geometry = new THREE.BoxGeometry();
    const solid = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    const glass = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.4 }));
    const glow = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ depthWrite: false }));
    const hidden = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ transparent: true }));
    hidden.visible = false;
    const foliage = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    foliage.material.userData.contactShadow = false;
    const particles = new THREE.Points(geometry, new THREE.PointsMaterial());
    scene.add(solid, glass, glow, hidden, particles, foliage);
    const renderer = { shadowMap: { autoUpdate: true } } as unknown as THREE.WebGLRenderer;
    const pass = new ContactShadows(scene, new THREE.PerspectiveCamera());
    const buffer = new THREE.WebGLRenderTarget(32, 32);
    vi.spyOn(GTAOPass.prototype, 'render').mockImplementation(() => {
      expect(solid.visible).toBe(true);
      expect(glass.visible).toBe(false);
      expect(glow.visible).toBe(false);
      expect(hidden.visible).toBe(false);
      expect(particles.visible).toBe(false);
      expect(foliage.visible).toBe(false);
      expect(scene.background).toBeNull();
      expect(renderer.shadowMap.autoUpdate).toBe(false);
      scene.overrideMaterial = pass.normalMaterial;
      if (fail) throw new Error('context unavailable');
    });
    if (fail) expect(() => pass.render(renderer, buffer, buffer)).toThrow('context unavailable');
    else pass.render(renderer, buffer, buffer);
    expect(glass.visible).toBe(true);
    expect(glow.visible).toBe(true);
    expect(hidden.visible).toBe(false);
    expect(particles.visible).toBe(true);
    expect(foliage.visible).toBe(true);
    expect(scene.background).toBe(background);
    expect(scene.overrideMaterial).toBe(override);
    expect(renderer.shadowMap.autoUpdate).toBe(true);
    pass.dispose();
    buffer.dispose();
    geometry.dispose();
    for (const mesh of [solid, glass, glow, hidden]) mesh.material.dispose();
    override.dispose();
    particles.material.dispose();
    foliage.material.dispose();
  });
});
