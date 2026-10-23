import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

/**
 * Contact shading reaches this far from the camera (m): the depth and normal pass draws nothing beyond it, and the
 * occlusion fades out over the last CONTACT_FADE metres so there is no edge where it ends. Farther away the 1.6 m
 * occlusion radius is a few pixels under fog, while the pass would draw every city chunk out to the horizon again.
 */
export const CONTACT_RANGE = 110;
export const CONTACT_FADE = 35;
/** The blend strength of the occlusion over the frame. */
export const CONTACT_INTENSITY = 0.65;
/**
 * While the camera moves faster than this (m/s, or turns faster than CONTACT_FAST_TURN rad/s) the occlusion fades out
 * over CONTACT_FADE_OUT s and the pass is skipped; it fades back in over CONTACT_FADE_IN s once the camera is below
 * CONTACT_SLOW_SPEED and CONTACT_SLOW_TURN. Driving, the contact shading under passing cars is lost in the motion.
 */
export const CONTACT_FAST_SPEED = 8;
export const CONTACT_SLOW_SPEED = 6;
export const CONTACT_FAST_TURN = 1.6;
export const CONTACT_SLOW_TURN = 1.1;
export const CONTACT_FADE_OUT = 0.25;
export const CONTACT_FADE_IN = 0.3;
/**
 * Resolution of the occlusion against the frame's: its 1.6 m radius and the denoise blur are many pixels wide, so half
 * resolution keeps the look at a quarter of the fragment work.
 */
export const CONTACT_SCALE = 0.5;

/** What three keeps per draw in a render list. */
interface Item {
  object: THREE.Object3D;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  group: THREE.GeometryGroup | null;
}

const noDepth = (m: THREE.Material): boolean => !m.depthWrite || m.transparent || m.opacity < 1 || m.userData.contactShadow === false;

const sphere = new THREE.Sphere();

/**
 * Whether a draw of the frame's opaque list goes into the depth and normal pass: not glass, smoke, lamp pools, halos,
 * points or lines, nothing that opted out (`contactShadow: false` on the object or its material: a pole dissolving
 * in front of the camera, the crowd), and nothing wholly further than `range` from `eye`.
 */
export function shadesContact(item: Item, eye: THREE.Vector3, range: number): boolean {
  const o = item.object as THREE.Mesh;
  if (!o.isMesh || (o as unknown as { isLine2?: boolean }).isLine2 || o.userData.contactShadow === false || noDepth(item.material)) return false;
  const g = item.geometry;
  if (!o.frustumCulled || !g.boundingSphere) return true;
  sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
  return sphere.center.distanceTo(eye) - sphere.radius <= range;
}

/**
 * Local occlusion grounds tyres, kerbs and porches even on the shaded side of a street. Its depth and normal pass does
 * not walk the scene again: it redraws the opaque draws of the frame just drawn (the renderer's own render list for the
 * scene) with the normal material, through a stand-in object whose onBeforeRender issues them inside a render call.
 */
export class ContactShadows extends GTAOPass {
  /** The camera the frame is drawn with; the pass draws depth and normals with a copy limited to CONTACT_RANGE. */
  private readonly view: THREE.Camera;
  private readonly lastPos = new THREE.Vector3(NaN, NaN, NaN);
  private readonly lastDir = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  /** Holds only the stand-in that draws the frame's opaque list (see the class comment). */
  private readonly drawScene = new THREE.Scene();
  private readonly draws: Item[] = [];
  private readonly clearWas = new THREE.Color();
  /** Whether the camera counts as moving fast (with hysteresis). */
  fast = false;
  /** 0..1: how much of the occlusion is drawn. */
  strength = 1;
  /** Draws in the last depth and normal pass. */
  drawn = 0;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    const near = camera instanceof THREE.PerspectiveCamera ? camera.clone() : camera;
    super(scene, near);
    this.view = camera;
    // Metres, not pixels: detail stays attached to the world when the driving camera pulls back.
    this.updateGtaoMaterial({ radius: 1.6, thickness: 0.6, distanceExponent: 2, distanceFallOff: 0.8, scale: 1, samples: 16, screenSpaceRadius: false });
    this.updatePdMaterial({ radius: 4, samples: 8, depthPhi: 2, normalPhi: 8 });
    this.blendIntensity = CONTACT_INTENSITY;
    const m = this.gtaoMaterial;
    m.uniforms.contactFadeStart = { value: CONTACT_RANGE - CONTACT_FADE };
    m.fragmentShader = m.fragmentShader
      .replace('uniform float cameraFar;', 'uniform float cameraFar;\nuniform float contactFadeStart;')
      .replace('ao = pow(ao, scale);', 'ao = pow(ao, scale);\n\t\t\tao = mix(ao, 1., smoothstep(contactFadeStart, cameraFar, -viewPos.z));');
    m.needsUpdate = true;
    // The stand-in itself draws nothing (no vertices).
    const standIn = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([], 3)), this.normalMaterial);
    standIn.frustumCulled = false;
    standIn.onBeforeRender = (renderer, scene, cam) => {
      const mat = this.normalMaterial;
      const inverse = cam.matrixWorldInverse;
      for (const d of this.draws) {
        const o = d.object;
        o.modelViewMatrix.multiplyMatrices(inverse, o.matrixWorld);
        o.normalMatrix.getNormalMatrix(o.modelViewMatrix);
        renderer.renderBufferDirect(cam, scene, d.geometry, mat, o, d.group as THREE.GeometryGroup);
      }
    };
    this.drawScene.add(standIn);
    this.syncCamera();
  }

  /**
   * Follows the drawn camera over a frame of `dt` seconds: whether it moves fast, how strongly the occlusion is drawn,
   * and so whether the pass runs at all this frame (`enabled`).
   */
  track(dt: number): void {
    const cam = this.view;
    cam.updateMatrixWorld();
    const pos = cam.getWorldPosition(this.pos);
    const fwd = cam.getWorldDirection(this.fwd);
    if (dt > 0 && Number.isFinite(this.lastPos.x)) {
      const speed = pos.distanceTo(this.lastPos) / dt;
      const turn = Math.acos(Math.min(1, Math.max(-1, fwd.dot(this.lastDir)))) / dt;
      // A teleport or cut is not motion to fade for.
      if (speed < 200) this.fast = this.fast ? speed > CONTACT_SLOW_SPEED || turn > CONTACT_SLOW_TURN : speed > CONTACT_FAST_SPEED || turn > CONTACT_FAST_TURN;
      const rate = dt / (this.fast ? CONTACT_FADE_OUT : CONTACT_FADE_IN);
      this.strength = this.fast ? Math.max(0, this.strength - rate) : Math.min(1, this.strength + rate);
    }
    this.lastPos.copy(pos);
    this.lastDir.copy(fwd);
    this.blendIntensity = CONTACT_INTENSITY * this.strength;
    this.enabled = this.strength > 0;
  }

  /** The depth pass's camera: the drawn one with its far plane at CONTACT_RANGE. */
  private syncCamera(): void {
    const cam = this.camera;
    if (cam === this.view || !(cam instanceof THREE.PerspectiveCamera) || !(this.view instanceof THREE.PerspectiveCamera)) return;
    cam.copy(this.view, false);
    cam.far = Math.min(this.view.far, CONTACT_RANGE);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  // GTAOPass hides points and lines by walking the scene twice a frame (untyped); shadesContact leaves them out.
  _overrideVisibility(): void {}
  _restoreVisibility(): void {}

  /** The depth and normal pass (GTAOPass's other override draws, for its debug outputs, go its own way). */
  _renderOverride(renderer: THREE.WebGLRenderer, overrideMaterial: THREE.Material, renderTarget: THREE.WebGLRenderTarget, clearColor: number, clearAlpha: number): void {
    if (overrideMaterial !== this.normalMaterial) {
      (GTAOPass.prototype as unknown as { _renderOverride: (...a: unknown[]) => void })._renderOverride.call(this, renderer, overrideMaterial, renderTarget, clearColor, clearAlpha);
      return;
    }
    const lists = (renderer as unknown as { renderLists?: { get(scene: THREE.Scene, depth: number): { opaque: Item[] } } }).renderLists;
    this.draws.length = 0;
    // The frame's own draw of the scene is the outermost render call (depth 0); this pass runs inside it.
    const eye = this.camera.getWorldPosition(this.eye);
    if (lists) for (const item of lists.get(this.scene, 0).opaque) if (shadesContact(item, eye, CONTACT_RANGE)) this.draws.push(item);
    this.drawn = this.draws.length;
    const color = renderer.getClearColor(this.clearWas);
    const alpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    renderer.setRenderTarget(renderTarget);
    renderer.autoClear = false;
    renderer.setClearColor(clearColor);
    renderer.setClearAlpha(clearAlpha || 0);
    renderer.clear();
    try {
      renderer.render(this.drawScene, this.camera);
    } finally {
      this.draws.length = 0;
      renderer.autoClear = autoClear;
      renderer.setClearColor(color);
      renderer.setClearAlpha(alpha);
    }
  }

  /** The occlusion and its depth and normals are worked out at CONTACT_SCALE of the frame and blended up into it. */
  override setSize(width: number, height: number): void {
    this.syncCamera();
    super.setSize(Math.max(1, Math.ceil(width * CONTACT_SCALE)), Math.max(1, Math.ceil(height * CONTACT_SCALE)));
  }

  override dispose(): void {
    super.dispose();
    // The bundled GTAOPass releases its targets and other materials, but omits these two.
    this.gtaoMaterial.dispose();
    this.blendMaterial.dispose();
    for (const o of this.drawScene.children) (o as THREE.Mesh).geometry.dispose();
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime = 0, maskActive = false): void {
    this.syncCamera();
    const shadows = renderer.shadowMap.autoUpdate;
    const override = this.scene.overrideMaterial;
    const background = this.scene.background;
    renderer.shadowMap.autoUpdate = false;
    this.scene.background = null;
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      renderer.shadowMap.autoUpdate = shadows;
      this.scene.overrideMaterial = override;
      this.scene.background = background;
    }
  }
}
