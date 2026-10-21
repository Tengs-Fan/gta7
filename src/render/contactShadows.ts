import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

/** Local occlusion grounds tyres, kerbs and porches even on the shaded side of a street. */
export class ContactShadows extends GTAOPass {
  private readonly hidden: THREE.Object3D[] = [];

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    super(scene, camera);
    // Metres, not pixels: detail stays attached to the world when the driving camera pulls back.
    this.updateGtaoMaterial({ radius: 1.6, thickness: 0.6, distanceExponent: 2, distanceFallOff: 0.8, scale: 1, samples: 16, screenSpaceRadius: false });
    this.updatePdMaterial({ radius: 4, samples: 8, depthPhi: 2, normalPhi: 8 });
    this.blendIntensity = 0.65;
  }

  override dispose(): void {
    super.dispose();
    // The bundled GTAOPass releases its targets and other materials, but omits these two.
    this.gtaoMaterial.dispose();
    this.blendMaterial.dispose();
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime = 0, maskActive = false): void {
    const shadows = renderer.shadowMap.autoUpdate;
    const override = this.scene.overrideMaterial;
    const background = this.scene.background;
    // Normal/depth rendering must not turn glass, smoke, lamp pools or objective halos into walls.
    // Their original visibility is restored even if WebGL fails during this pass.
    this.scene.traverseVisible((object) => {
      if (object instanceof THREE.Points || object instanceof THREE.Line) {
        this.hidden.push(object);
        return;
      }
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (materials.every((m) => !m.depthWrite || m.transparent || m.opacity < 1 || m.userData.contactShadow === false)) {
        this.hidden.push(object);
      }
    });
    for (const object of this.hidden) object.visible = false;
    renderer.shadowMap.autoUpdate = false;
    this.scene.background = null;
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      for (const object of this.hidden) object.visible = true;
      this.hidden.length = 0;
      renderer.shadowMap.autoUpdate = shadows;
      this.scene.overrideMaterial = override;
      this.scene.background = background;
    }
  }
}
