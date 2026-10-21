import * as THREE from 'three';
import type { StaticWorld } from '../world/staticWorld';

/** A small, stable pool of real lamp light: cars and facades pick up warm light as they pass. */
export class StreetLighting {
  readonly group = new THREE.Group();
  private readonly lamps: number[];
  private readonly slots: Array<{ light: THREE.SpotLight; lamp: number; fade: number }> = [];

  constructor(private readonly world: StaticWorld) {
    this.group.name = 'street-lighting';
    this.lamps = world.layout.props.flatMap((p, i) => p.kind === 'lamp' ? [i] : []);
    for (let i = 0; i < 6; i++) {
      const light = new THREE.SpotLight(0xffd09a, 0, 22, 1.12, 0.75, 2);
      this.group.add(light, light.target);
      this.slots.push({ light, lamp: -1, fade: 0 });
    }
  }

  update(camera: THREE.Vector3, night: number, dt: number): void {
    if (!this.group.visible) return;
    const nearby = this.lamps.map((i) => {
      const p = this.world.layout.props[i]!;
      return { i, d: (p.x - camera.x) ** 2 + (p.z - camera.z) ** 2 };
    }).filter(({ i, d }) => d < 44 * 44 && !this.broken(i)).sort((a, b) => a.d - b.d).slice(0, this.slots.length);
    const wanted = new Set(nearby.map(({ i }) => i));
    const assigned = new Set(this.slots.map((s) => s.lamp));
    for (const slot of this.slots) {
      const keep = wanted.has(slot.lamp);
      // A broken lamp goes out immediately; normal pool changes cross-fade without popping.
      slot.fade = this.broken(slot.lamp) ? 0 : THREE.MathUtils.clamp(slot.fade + (keep ? 1 : -1) * dt * 3, 0, 1);
      if (!keep && slot.fade === 0) {
        assigned.delete(slot.lamp);
        slot.lamp = nearby.find(({ i }) => !assigned.has(i))?.i ?? -1;
        assigned.add(slot.lamp);
      }
      if (slot.lamp < 0) {
        slot.light.intensity = 0;
        continue;
      }
      const p = this.world.layout.props[slot.lamp]!;
      const x = p.x + Math.sin(p.rot) * 1.55 * p.scale;
      const z = p.z + Math.cos(p.rot) * 1.55 * p.scale;
      slot.light.position.set(x, p.y + 6.23 * p.scale, z);
      slot.light.target.position.set(x, p.y, z);
      slot.light.target.updateMatrixWorld();
      slot.light.intensity = 55 * night * slot.fade;
    }
  }

  private broken(i: number): boolean {
    const collider = this.world.propColliders[i];
    return collider !== undefined && collider >= 0 && !!this.world.grid.colliders[collider]?.broken;
  }
}
