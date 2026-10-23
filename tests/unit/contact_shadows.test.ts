import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContactShadows, shadesContact } from '../../src/render/contactShadows';

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

  // Revised for track D: the depth and normal pass now redraws the frame's opaque render list instead of hiding
  // objects and walking the scene again, so the selection is checked on render items (shadesContact).
  it('keeps glass, light pools, opted-out batches, points and far things out of depth', () => {
    const geometry = new THREE.BoxGeometry();
    geometry.computeBoundingSphere();
    const item = (object: THREE.Object3D, material: THREE.Material) => ({ object, geometry, material, group: null });
    const mesh = (m: THREE.Material, x = 0) => {
      const o = new THREE.Mesh(geometry, m);
      o.position.set(x, 0, 0);
      o.updateMatrixWorld();
      return o;
    };
    const eye = new THREE.Vector3();
    const solid = new THREE.MeshStandardMaterial();
    expect(shadesContact(item(mesh(solid), solid), eye, 110)).toBe(true);
    const glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    expect(shadesContact(item(mesh(glass), glass), eye, 110)).toBe(false);
    const glow = new THREE.MeshBasicMaterial({ depthWrite: false });
    expect(shadesContact(item(mesh(glow), glow), eye, 110)).toBe(false);
    const foliage = new THREE.MeshStandardMaterial();
    foliage.userData.contactShadow = false;
    expect(shadesContact(item(mesh(foliage), foliage), eye, 110)).toBe(false);
    const optedOut = mesh(solid);
    optedOut.userData.contactShadow = false;
    expect(shadesContact(item(optedOut, solid), eye, 110)).toBe(false);
    const points = new THREE.PointsMaterial();
    expect(shadesContact(item(new THREE.Points(geometry, points), points), eye, 110)).toBe(false);
    // Beyond the range (a unit box's bounding sphere reaches 0.87 m towards the eye).
    expect(shadesContact(item(mesh(solid, 110.5), solid), eye, 110)).toBe(true);
    expect(shadesContact(item(mesh(solid, 111.5), solid), eye, 110)).toBe(false);
    for (const m of [solid, glass, glow, foliage, points]) m.dispose();
    geometry.dispose();
  });

  it.each([false, true])('restores scene state after the pass (error=%s)', (fail) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x123456);
    const background = scene.background;
    const override = new THREE.MeshBasicMaterial();
    scene.overrideMaterial = override;
    const renderer = { shadowMap: { autoUpdate: true } } as unknown as THREE.WebGLRenderer;
    const pass = new ContactShadows(scene, new THREE.PerspectiveCamera());
    const buffer = new THREE.WebGLRenderTarget(32, 32);
    vi.spyOn(GTAOPass.prototype, 'render').mockImplementation(() => {
      expect(scene.background).toBeNull();
      expect(renderer.shadowMap.autoUpdate).toBe(false);
      scene.overrideMaterial = pass.normalMaterial;
      if (fail) throw new Error('context unavailable');
    });
    if (fail) expect(() => pass.render(renderer, buffer, buffer)).toThrow('context unavailable');
    else pass.render(renderer, buffer, buffer);
    expect(scene.background).toBe(background);
    expect(scene.overrideMaterial).toBe(override);
    expect(renderer.shadowMap.autoUpdate).toBe(true);
    pass.dispose();
    buffer.dispose();
    override.dispose();
  });
});
