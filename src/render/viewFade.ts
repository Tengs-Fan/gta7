// Fading a bike or boat view in (its vehicle just appeared) or out where it is (removed in view), the way VehicleView
// fades a car: every mesh it draws itself takes a hashed-alpha copy of its material (fadeMaterial, the programs the
// warm-up compiles; a see-through one such as glass or the foam ring scales its opacity instead) and every shadow
// caster a hashed-alpha depth material, so the vehicle and its shadow dissolve together. Parts drawn through the shared
// part batches (userData.batched) keep their materials: the view hands the batches its fade level per instance.

import * as THREE from 'three';
import { fadeMaterial } from './vehicleView';

interface Entry {
  mesh: THREE.Mesh;
  material: THREE.Material;
  clone: THREE.Material;
  opacity: number;
}

export class GroupFade {
  private state: { entries: Entry[]; depth: THREE.MeshDepthMaterial; spent: THREE.Material[] } | null = null;
  private left = 1;

  get active(): boolean {
    return this.state !== null;
  }

  /** How much of the view is drawn (1 whole .. 0 gone); 1 when no fade runs. */
  get level(): number {
    return this.state ? this.left : 1;
  }

  begin(group: THREE.Object3D): void {
    if (this.state) return;
    const entries: Entry[] = [];
    const depth = new THREE.MeshDepthMaterial({ alphaHash: true });
    group.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.userData.batched || Array.isArray(o.material)) return;
      const material = o.material as THREE.Material;
      const clone = fadeMaterial(material);
      entries.push({ mesh: o, material, clone, opacity: material.opacity });
      o.material = clone;
      if (o.castShadow) o.customDepthMaterial = depth;
    });
    this.state = { entries, depth, spent: [] };
    this.left = 1;
  }

  /** How much is left (1 whole .. 0 gone). */
  set(group: THREE.Object3D, f: number): void {
    const s = this.state;
    if (!s) return;
    for (const e of s.entries) e.clone.opacity = e.clone.transparent ? e.opacity * f : f;
    s.depth.opacity = f;
    this.left = f;
    group.visible = f > 0;
  }

  /**
   * A mesh's material changed while fading (paint on a new colour, a burnt-out wreck): its fade copy follows, so the
   * fade keeps covering it. The copy it replaces is handed back by end with the others.
   */
  swap(mesh: THREE.Mesh, material: THREE.Material): void {
    const s = this.state;
    const e = s?.entries.find((q) => q.mesh === mesh);
    if (!s || !e) {
      mesh.material = material;
      return;
    }
    s.spent.push(e.clone);
    e.material = material;
    e.opacity = material.opacity;
    e.clone = fadeMaterial(material);
    e.clone.opacity = e.clone.transparent ? e.opacity * this.left : this.left;
    mesh.material = e.clone;
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
    this.left = 1;
    return [...s.entries.map((e) => e.clone), ...s.spent, s.depth];
  }
}
