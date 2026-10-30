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
  /** The filtered map shows this car's surroundings: false after a release or warm-up until the next full capture. */
  private current = false;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.camera.coordinateSystem = THREE.WebGLCoordinateSystem;
    this.camera.updateCoordinateSystem();
  }

  get ready(): boolean { return this.filtered !== null && this.current; }
  get capturing(): boolean { return this.face >= 0; }

  /** Vehicle damage/glass sync can restore a shared material each frame, before the main draw. */
  applyCurrent(target: THREE.Object3D): void {
    if (this.target === target && this.filtered && this.current) this.syncFinishes(target, this.filtered.texture);
  }

  update(target: THREE.Object3D, position: THREE.Vector3, hours: number, time: number, excluded: readonly THREE.Object3D[]): void {
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
      (this.capturedAt.distanceToSquared(position) > 12 * 12 || Math.min(hourDelta, 24 - hourDelta) > RECAPTURE_HOURS || !this.filtered || !this.current)) {
      this.camera.position.copy(position);
      this.camera.updateMatrixWorld(true);
      this.face = 0;
      this.captureTime = time;
      this.capturedHour = hours;
    }
    if (this.face >= 0) {
      this.captureFace(excluded);
      this.face++;
      if (this.face === 6) {
        this.filterCube();
        this.current = true;
        this.capturedAt.copy(this.camera.position);
        this.face = -1;
      }
    }
    if (this.filtered && this.current) this.syncFinishes(target, this.filtered.texture);
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
      // Leave the main scene on its original target.
      renderer.xr.enabled = xr;
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(target, face, mip);
    }
  }

  private captureFace(excludedRoots: readonly THREE.Object3D[]): void {
    const renderer = this.renderer;
    const excluded = keepLights(excludedRoots);
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

  /**
   * The player left the car: the shared finishes go back, but the cube, the filtered map and the filter stay, so the
   * next car builds no filter program. The old map is not shown again; the next car captures its own first.
   */
  release(): void {
    this.restoreFinishes();
    this.target = null;
    this.face = -1;
    this.current = false;
    this.capturedAt.set(Infinity, Infinity, Infinity);
    this.captureTime = -100;
  }

  /**
   * Warm-up: filters the blank cube once, which builds the filter's program for this cube size, and puts a reflective
   * finish with the filtered map on each target, so the renderer's compile covers them. `endWarm` follows the compile.
   */
  warm(targets: readonly THREE.Object3D[]): void {
    this.filterCube();
    this.current = false;
    for (const t of targets) this.syncFinishes(t, this.filtered!.texture);
  }

  /** Puts the shared materials back after `warm` and returns its finishes undisposed: kept, their programs stay. */
  endWarm(): THREE.Material[] {
    const kept: THREE.Material[] = [];
    for (const [mesh, finish] of this.finishes) {
      if (mesh.material === finish.local) mesh.material = finish.source;
      kept.push(finish.local);
    }
    this.finishes.clear();
    return kept;
  }

  dispose(): void {
    this.restoreFinishes();
    this.filtered?.dispose();
    this.filtered = null;
    this.cube.dispose();
    this.pmrem.dispose();
  }
}

/**
 * The objects to hide for a cube face, with their lights left on: hiding a group that holds lights (the effects' flash
 * and muzzle) gave the faces a different light set from the frame's, so every material in view built a second program
 * on the first capture. Such a group is hidden child by child instead.
 */
export function keepLights(objects: readonly THREE.Object3D[]): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const visit = (o: THREE.Object3D): void => {
    if (isLight(o)) return;
    if (!holdsLight(o)) out.push(o);
    else for (const c of o.children) visit(c);
  };
  for (const o of objects) visit(o);
  return out;
}

const isLight = (o: THREE.Object3D): boolean => (o as THREE.Light).isLight === true;
/** A light among the children or grandchildren: deep enough for the views' groups, and cheap enough for every face. */
const holdsLight = (o: THREE.Object3D): boolean => o.children.some((c) => isLight(c) || c.children.some(isLight));
