import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { StreetLighting } from '../../src/render/streetLighting';
import { world } from './helpers';

describe('local street lighting', () => {
  it('illuminates nearby lamps at night, follows break/restore state, and fades on leaving', () => {
    const w = world();
    const index = w.layout.props.findIndex((p) => p.kind === 'lamp');
    const p = w.layout.props[index]!;
    const lights = new StreetLighting(w);
    const camera = new THREE.Vector3(p.x, p.y + 2, p.z);
    const spots = lights.group.children.filter((c): c is THREE.SpotLight => c instanceof THREE.SpotLight);
    const tick = (night: number) => { for (let i = 0; i < 8; i++) lights.update(camera, night, 0.1); };
    tick(1);
    const x = p.x + Math.sin(p.rot) * 1.55 * p.scale;
    const z = p.z + Math.cos(p.rot) * 1.55 * p.scale;
    const atLamp = () => spots.find((l) => Math.abs(l.position.x - x) < 1e-6 && Math.abs(l.position.z - z) < 1e-6);
    expect(atLamp()?.intensity).toBeGreaterThan(0);
    const collider = w.grid.colliders[w.propColliders[index]!]!;
    collider.broken = true;
    try {
      lights.update(camera, 1, 0.1);
      expect(atLamp()?.intensity ?? 0).toBe(0);
    } finally {
      collider.broken = false;
    }
    tick(1);
    expect(atLamp()?.intensity).toBeGreaterThan(0);
    tick(0);
    expect(spots.every((l) => l.intensity === 0)).toBe(true);
    tick(1);
    camera.set(10000, 0, 10000);
    tick(1);
    expect(spots.every((l) => l.intensity === 0)).toBe(true);
  });
});
