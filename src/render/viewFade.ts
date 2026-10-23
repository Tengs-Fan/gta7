// Fading a bike or boat view out where it is, the way VehicleView fades a car (its vehicle was removed in view):
// every mesh takes a hashed-alpha copy of its material (fadeMaterial, the programs the warm-up compiles) and every
// shadow caster a hashed-alpha depth material, so the vehicle and its shadow dissolve together.

import * as THREE from 'three';
import { fadeMaterial } from './vehicleView';

interface Entry {
  mesh: THREE.Mesh;
  material: THREE.Material;
  clone: THREE.Material;
  opacity: number;
}

export class GroupFade {
  private state: { entries: Entry[]; depth: THREE.MeshDepthMaterial } | null = null;

  get active(): boolean {
    return this.state !== null;
  }

  begin(group: THREE.Object3D): void {
    if (this.state) return;
    const entries: Entry[] = [];
    const depth = new THREE.MeshDepthMaterial({ alphaHash: true });
    group.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
      const material = o.material as THREE.Material;
      const clone = fadeMaterial(material);
      entries.push({ mesh: o, material, clone, opacity: material.opacity });
      o.material = clone;
      if (o.castShadow) o.customDepthMaterial = depth;
    });
    this.state = { entries, depth };
  }

  /** How much is left (1 whole .. 0 gone). */
  set(group: THREE.Object3D, f: number): void {
    const s = this.state;
    if (!s) return;
    for (const e of s.entries) e.clone.opacity = e.clone.transparent ? e.opacity * f : f;
    s.depth.opacity = f;
    group.visible = f > 0;
  }

  /** Puts the meshes' own materials back; returns the fade materials for the caller to dispose. */
  end(): THREE.Material[] {
    const s = this.state;
    if (!s) return [];
    for (const e of s.entries) {
      e.mesh.material = e.material;
      e.mesh.customDepthMaterial = undefined;
    }
    this.state = null;
    return [...s.entries.map((e) => e.clone), s.depth];
  }
}
