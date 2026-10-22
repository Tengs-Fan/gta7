import * as THREE from 'three';

type ReflectiveMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
interface Finish { source: THREE.MeshStandardMaterial; local: THREE.MeshStandardMaterial }

// Hour differences carry float error (12.05 - 12 = 0.05000000000000071), so exactly 0.05 h needs slack.
const RECAPTURE_HOURS = 0.05 + 1e-9;

/** Local city reflections on the player's car, captured one cube face per frame. */
export class LocalReflections {
  private readonly cube = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: false });
  private readonly camera = new THREE.CubeCamera(0.3, 400, this.cube);
  private readonly pmrem: THREE.PMREMGenerator;
  private filtered: THREE.WebGLRenderTarget | null = null;
  private readonly finishes = new Map<ReflectiveMesh, Finish>();
  private target: THREE.Object3D | null = null;
  private face = -1;
  private capturedAt = new THREE.Vector3(Infinity, Infinity, Infinity);
  private capturedHour = -100;
  private captureTime = -100;
  private disabled = false;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.camera.coordinateSystem = THREE.WebGLCoordinateSystem;
    this.camera.updateCoordinateSystem();
  }

  get ready(): boolean { return this.filtered !== null && !this.disabled; }
  get capturing(): boolean { return this.face >= 0 && !this.disabled; }

  /** Vehicle damage/glass sync can restore a shared material each frame, before the main draw. */
  applyCurrent(target: THREE.Object3D): void {
    if (this.target === target && this.filtered && !this.disabled) this.syncFinishes(target, this.filtered.texture);
  }

  update(target: THREE.Object3D, position: THREE.Vector3, hours: number, time: number, excluded: readonly THREE.Object3D[]): void {
    if (this.disabled) return;
    if (this.target !== target) {
      this.restoreFinishes();
      this.target = target;
      this.face = -1;
      this.capturedAt.set(Infinity, Infinity, Infinity);
      this.captureTime = -100;
    }
    const hourDelta = Math.abs(hours - this.capturedHour);
    // A single stationary car needs a new probe only when its lighting changes. Moving cars get
    // a refresh every 12 metres, capped at twice per second; a teleport starts a coherent new cube.
    if (this.face >= 0 && this.camera.position.distanceToSquared(position) > 50 * 50) this.face = -1;
    if (this.face < 0 && time - this.captureTime >= 0.5 &&
      (this.capturedAt.distanceToSquared(position) > 12 * 12 || Math.min(hourDelta, 24 - hourDelta) > RECAPTURE_HOURS || !this.filtered)) {
      this.camera.position.copy(position);
      this.camera.updateMatrixWorld(true);
      this.face = 0;
      this.captureTime = time;
      this.capturedHour = hours;
    }
    try {
      if (this.face >= 0) {
        this.captureFace(excluded);
        this.face++;
        if (this.face === 6) {
          this.filterCube();
          this.capturedAt.copy(this.camera.position);
          this.face = -1;
        }
      }
      if (this.filtered) this.syncFinishes(target, this.filtered.texture);
    } catch {
      // Optional enhancement: a driver that cannot capture the HDR cube keeps the sky reflection.
      this.restoreFinishes();
      this.disabled = true;
    }
  }

  private filterCube(): void {
    const renderer = this.renderer;
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace();
    const mip = renderer.getActiveMipmapLevel();
    const xr = renderer.xr.enabled;
    const autoClear = renderer.autoClear;
    try {
      const next = this.pmrem.fromCubemap(this.cube.texture, this.filtered);
      if (next !== this.filtered) this.filtered?.dispose();
      this.filtered = next;
    } finally {
      // PMREM may fail during driver/context loss. Leave the main scene on its original target.
      renderer.xr.enabled = xr;
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(target, face, mip);
    }
  }

  private captureFace(excluded: readonly THREE.Object3D[]): void {
    const renderer = this.renderer;
    const target = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace();
    const mip = renderer.getActiveMipmapLevel();
    const shadows = renderer.shadowMap.autoUpdate;
    const toneMapping = renderer.toneMapping;
    const xr = renderer.xr.enabled;
    const visibility = excluded.map((object) => object.visible);
    try {
      excluded.forEach((object) => { object.visible = false; });
      renderer.shadowMap.autoUpdate = false;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.xr.enabled = false;
      renderer.setRenderTarget(this.cube, this.face);
      renderer.render(this.scene, this.camera.children[this.face] as THREE.Camera);
    } finally {
      excluded.forEach((object, i) => { object.visible = visibility[i]!; });
      renderer.shadowMap.autoUpdate = shadows;
      renderer.toneMapping = toneMapping;
      renderer.xr.enabled = xr;
      renderer.setRenderTarget(target, cubeFace, mip);
    }
  }

  /** Clone only the selected car's reflective finishes; traffic keeps shared materials. */
  private syncFinishes(target: THREE.Object3D, texture: THREE.Texture): void {
    target.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !['body', 'glass', 'exterior', 'rim'].includes(object.name)) return;
      if (!(object.material instanceof THREE.MeshStandardMaterial)) return;
      const mesh = object as ReflectiveMesh;
      const old = this.finishes.get(mesh);
      const source = mesh.material === old?.local ? old.source : mesh.material;
      // Charred wrecks should retain their matte burnt material.
      if (source.roughness > 0.8 && source.metalness < 0.3) {
        if (old) { if (mesh.material === old.local) mesh.material = old.source; old.local.dispose(); this.finishes.delete(mesh); }
        return;
      }
      let finish = old;
      if (!finish || source !== finish.source) {
        old?.local.dispose();
        const local = source.clone();
        local.envMap = texture;
        local.envMapIntensity = 1;
        finish = { source, local };
        this.finishes.set(mesh, finish);
      }
      finish.local.envMap = texture;
      mesh.material = finish.local;
    });
  }

  private restoreFinishes(): void {
    for (const [mesh, finish] of this.finishes) {
      // Vehicle pooling may already have replaced the material for a different vehicle.
      if (mesh.material === finish.local) mesh.material = finish.source;
      finish.local.dispose();
    }
    this.finishes.clear();
  }

  dispose(): void {
    this.restoreFinishes();
    this.filtered?.dispose();
    this.filtered = null;
    this.cube.dispose();
    this.pmrem.dispose();
  }
}
