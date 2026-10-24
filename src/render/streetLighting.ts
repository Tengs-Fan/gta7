import * as THREE from 'three';
import { axisOf, type Dir } from '../world/roads';
import type { StaticWorld } from '../world/staticWorld';
import type { LightSprites } from './lightSprites';
import { STREAK_RANGE } from './lightSprites';
import { LAMP_HEAD } from './props';

/** A traffic signal's lit bulb as a wet-road streak light: linear colour at full strength. */
export const SIGNAL_STREAK: Readonly<Record<'red' | 'yellow' | 'green', readonly [number, number, number]>> = {
  red: [0.95, 0.04, 0.015],
  yellow: [0.95, 0.45, 0.03],
  green: [0.05, 0.95, 0.38],
};
/** Bulb heights on the signal head (as props.ts builds them: red on top) and their reach out of the pole. */
const BULB_Y = { red: 4.88, yellow: 4.55, green: 4.22 } as const;
const BULB_Z = 0.21;

/** A small, stable pool of real lamp light: cars and facades pick up warm light as they pass. */
export class StreetLighting {
  readonly group = new THREE.Group();
  private readonly lamps: number[];
  private readonly signals: number[];
  private readonly slots: Array<{ light: THREE.SpotLight; lamp: number; fade: number }> = [];

  constructor(private readonly world: StaticWorld) {
    this.group.name = 'street-lighting';
    this.lamps = world.layout.props.flatMap((p, i) => p.kind === 'lamp' ? [i] : []);
    this.signals = world.layout.props.flatMap((p, i) => p.kind === 'signal' ? [i] : []);
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
      const x = p.x + Math.sin(p.rot) * LAMP_HEAD.reach * p.scale;
      const z = p.z + Math.cos(p.rot) * LAMP_HEAD.reach * p.scale;
      // Just under the lens, so the head does not shadow its own light.
      slot.light.position.set(x, p.y + (LAMP_HEAD.y - 0.06) * p.scale, z);
      slot.light.target.position.set(x, p.y, z);
      slot.light.target.updateMatrixWorld();
      slot.light.intensity = 55 * night * slot.fade;
    }
  }

  /**
   * Offers the lit bulb of every standing traffic signal within STREAK_RANGE of the camera as a wet-road streak light in
   * the bulb's own colour (on every tier). `signalTime` is the sim clock the signals run on.
   */
  offerSignalStreaks(sprites: LightSprites, camera: THREE.Vector3, signalTime: number): void {
    const props = this.world.layout.props;
    const roads = this.world.roads;
    for (const i of this.signals) {
      const p = props[i]!;
      const dx = p.x - camera.x;
      const dz = p.z - camera.z;
      if (dx * dx + dz * dz > STREAK_RANGE * STREAK_RANGE || this.broken(i)) continue;
      const st = roads.signalState(p.node, axisOf(p.dir as Dir), signalTime);
      if (st !== 'red' && st !== 'yellow' && st !== 'green') continue;
      const c = SIGNAL_STREAK[st];
      sprites.offerStreakLight(p.x + Math.sin(p.rot) * BULB_Z, p.y + BULB_Y[st], p.z + Math.cos(p.rot) * BULB_Z, c[0], c[1], c[2]);
    }
  }

  private broken(i: number): boolean {
    const collider = this.world.propColliders[i];
    return collider !== undefined && collider >= 0 && !!this.world.grid.colliders[collider]?.broken;
  }
}
