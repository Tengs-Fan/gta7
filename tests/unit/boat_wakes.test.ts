// Boat wakes (render/boatWakes.ts): one draw of ribbons over each boat's recent stern points, the churned trail down the
// middle and the Kelvin wake's two arms spreading at 19.5 degrees from its track, fading out over WAKE_LIFE s; a fixed
// pool of boats and points, so a crowd of boats or hours of play neither grow it nor allocate.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BoatWakes, KELVIN, WAKE_BOATS, WAKE_LIFE, WAKE_POINTS, WAKE_STEP } from '../../src/render/boatWakes';

const DT = 1 / 60;

/** Runs boat `id` north (+z) from z0 at `speed` m/s for `seconds`, feeding and updating every frame; returns the time. */
function run(w: BoatWakes, id: number, x: number, z0: number, speed: number, seconds: number, t0 = 0): number {
  let t = t0;
  for (let f = 0; f < seconds / DT; f++) {
    t += DT;
    w.feed(id, x, z0 + speed * (t - t0), 0, 1, speed, 1, 1.15);
    w.update(t);
  }
  return t;
}

/** The ribbon vertices of the first boat slot with any strength: position (x, z), strength and kind (0 trail, 1 arm). */
function live(w: BoatWakes): Array<{ x: number; z: number; k: number; kind: number }> {
  const pos = w.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const foam = w.mesh.geometry.getAttribute('aFoam') as THREE.BufferAttribute;
  const out: Array<{ x: number; z: number; k: number; kind: number }> = [];
  for (let i = 0; i < pos.count; i++) if (foam.getX(i) > 0) out.push({ x: pos.getX(i), z: pos.getZ(i), k: foam.getX(i), kind: foam.getZ(i) });
  return out;
}

describe('boat wakes', () => {
  it('a boat under way leaves a trail of stern points every few metres, and a stopped one leaves none', () => {
    const w = new BoatWakes();
    w.update(0);
    expect(w.mesh.visible).toBe(false);
    run(w, 7, 0, 0, 12, 2);
    expect(w.mesh.visible).toBe(true);
    // 24 m at a point per WAKE_STEP m, and the head at the stern.
    expect(w.points).toBeGreaterThanOrEqual(Math.floor(24 / WAKE_STEP));
    expect(w.points).toBeLessThanOrEqual(Math.ceil(24 / WAKE_STEP) + 2);
  });

  it('the arms spread from the track at the Kelvin angle, and the trail stays on it', () => {
    const w = new BoatWakes();
    const speed = 14;
    run(w, 1, 0, 0, speed, 3);
    const v = live(w);
    const arms = v.filter((p) => p.kind === 1);
    const trail = v.filter((p) => p.kind === 0);
    expect(arms.length).toBeGreaterThan(20);
    // Half way back along the wake the arms lie KELVIN times the distance behind the stern out from the track (give or
    // take the hull and the arm's own width), the trail within a few metres of it.
    const sternZ = speed * 3;
    for (const p of arms) {
      const behind = sternZ - p.z;
      if (behind < 10) continue;
      expect(Math.abs(p.x)).toBeGreaterThan(KELVIN * behind * 0.85);
      expect(Math.abs(p.x)).toBeLessThan(KELVIN * behind * 1.1 + 3);
    }
    for (const p of trail) expect(Math.abs(p.x)).toBeLessThan(3);
    expect(KELVIN).toBeCloseTo(Math.tan((19.47 * Math.PI) / 180), 9);
  });

  it('fades out over WAKE_LIFE once the boat stops, and a teleport starts a new trail', () => {
    const w = new BoatWakes();
    let t = run(w, 3, 0, 0, 12, 2);
    const fresh = Math.max(...live(w).map((p) => p.k));
    for (let f = 0; f < (WAKE_LIFE * 0.5) / DT; f++) w.update((t += DT));
    expect(w.points).toBeGreaterThan(0);
    expect(Math.max(...live(w).map((p) => p.k))).toBeLessThan(fresh);
    for (let f = 0; f < (WAKE_LIFE * 0.6) / DT; f++) w.update((t += DT));
    expect(w.points).toBe(0);
    expect(w.mesh.visible).toBe(false);
    // Under way again 500 m away: no ribbon spans the jump.
    t = run(w, 3, 0, 0, 12, 1, t);
    t = run(w, 3, 500, 0, 12, 1, t);
    expect(Math.min(...live(w).map((p) => p.x))).toBeGreaterThan(480);
  });

  it('more boats than its pool hand the oldest slot on, and its buffers never change size', () => {
    const w = new BoatWakes();
    const pos = w.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const count = pos.count;
    let t = 0;
    for (let f = 0; f < 120; f++) {
      t += DT;
      for (let id = 0; id < WAKE_BOATS + 4; id++) w.feed(id, id * 30, 12 * t, 0, 1, 12, 1, 1);
      w.update(t);
    }
    expect(w.points).toBeLessThanOrEqual(WAKE_BOATS * (WAKE_POINTS + 1));
    expect(w.mesh.geometry.getAttribute('position')).toBe(pos);
    expect(pos.count).toBe(count);
    expect(pos.array.length).toBe(WAKE_BOATS * 3 * (WAKE_POINTS + 1) * 2 * 3);
    w.clear();
    w.update(t + DT);
    expect(w.points).toBe(0);
  });

  it('rides the sea\'s waves in one transparent draw that writes no depth', () => {
    const w = new BoatWakes();
    const u = { uWavePhase: { value: new THREE.Vector4() }, uSeaAmp: { value: 0.3 }, uDisplace: { value: 1 }, uSeaOrigin: { value: new THREE.Vector2() } };
    w.bindSea(u);
    const mat = w.mesh.material as THREE.ShaderMaterial;
    expect(mat.uniforms.uDisplace).toBe(u.uDisplace);
    expect(mat.uniforms.uWavePhase).toBe(u.uWavePhase);
    expect(mat.vertexShader).toContain('uDisplace * seaDisplace(position.xz)');
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(w.mesh).toBeInstanceOf(THREE.Mesh);
  });
});
