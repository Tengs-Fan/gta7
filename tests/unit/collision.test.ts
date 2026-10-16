import { describe, expect, it } from 'vitest';
import {
  circleVsAabb, circleVsCircle, circleVsObb, makeContact, obbVsAabb, obbVsObb, rayAabb3, rayCylinderY, rayObb3,
} from '../../src/core/collision';
import { angleDiff, wrapAngle } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import { StaticGrid, makeRayHit } from '../../src/world/colliders';

describe('math', () => {
  it('wraps angles into (-pi, pi]', () => {
    for (let a = -20; a <= 20; a += 0.37) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThan(-Math.PI - 1e-9);
      expect(w).toBeLessThanOrEqual(Math.PI + 1e-9);
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 9);
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 9);
    }
    expect(angleDiff(3, -3)).toBeCloseTo(2 * Math.PI - 6, 9);
    expect(wrapAngle(Number.NaN)).toBe(0);
  });
});

describe('SAT contacts', () => {
  const c = makeContact();

  it('pushes an OBB out of an AABB along the shallow axis', () => {
    // Car (2 x 4.4) centred just left of a wall box, overlapping by 0.5 m on X.
    const hit = obbVsAabb({ x: -1.5, z: 0, hw: 1, hl: 2.2, h: 0 }, { minX: -1, minZ: -10, maxX: 10, maxZ: 10 }, c);
    expect(hit).toBe(true);
    expect(c.nx).toBeCloseTo(-1, 6);
    expect(c.nz).toBeCloseTo(0, 6);
    expect(c.depth).toBeCloseTo(0.5, 6);
  });

  it('reports no contact for separated shapes, including diagonal gaps', () => {
    expect(obbVsAabb({ x: -3, z: 0, hw: 1, hl: 2.2, h: 0 }, { minX: -1, minZ: -10, maxX: 10, maxZ: 10 }, c)).toBe(false);
    // Rotated 45 degrees near a box corner where only the OBB axes separate.
    expect(obbVsAabb({ x: -2.2, z: -2.2, hw: 0.5, hl: 1.5, h: Math.PI / 4 }, { minX: -1, minZ: -1, maxX: 1, maxZ: 1 }, c)).toBe(false);
  });

  it('gives a contact point on the penetrating corner', () => {
    // OBB rotated so one corner pokes into the box top face (z = 0 face of box below z=0... box spans z<0).
    const hit = obbVsAabb({ x: 0, z: 1.3, hw: 1, hl: 1, h: Math.PI / 4 }, { minX: -5, minZ: -5, maxX: 5, maxZ: 0 }, c);
    expect(hit).toBe(true);
    expect(c.nz).toBeCloseTo(1, 6);
    expect(c.depth).toBeCloseTo(Math.SQRT2 - 1.3, 6);
    expect(c.px).toBeCloseTo(0, 6);
    expect(c.pz).toBeCloseTo(1.3 - Math.SQRT2, 6);
  });

  it('resolves OBB vs OBB symmetrically', () => {
    const a = { x: 0, z: 0, hw: 1, hl: 2, h: 0.3 };
    const b = { x: 1.5, z: 0.5, hw: 1, hl: 2, h: -0.2 };
    const c2 = makeContact();
    expect(obbVsObb(a, b, c)).toBe(true);
    expect(obbVsObb(b, a, c2)).toBe(true);
    expect(c.depth).toBeCloseTo(c2.depth, 6);
    expect(c.nx).toBeCloseTo(-c2.nx, 6);
    expect(c.nz).toBeCloseTo(-c2.nz, 6);
    // The normal pushes a away from b (b is to the +x side).
    expect(c.nx).toBeLessThan(0);
    // After separating along the normal by the depth they no longer overlap.
    const moved = { ...a, x: a.x + c.nx * (c.depth + 1e-4), z: a.z + c.nz * (c.depth + 1e-4) };
    expect(obbVsObb(moved, b, c2)).toBe(false);
  });

  it('handles circles against boxes, including centres inside', () => {
    expect(circleVsAabb(0, -1.2, 0.5, { minX: -1, minZ: -1, maxX: 1, maxZ: 1 }, c)).toBe(true);
    expect(c.nz).toBeCloseTo(-1, 6);
    expect(c.depth).toBeCloseTo(0.3, 6);
    expect(circleVsAabb(0.9, 0, 0.5, { minX: -1, minZ: -1, maxX: 1, maxZ: 1 }, c)).toBe(true);
    expect(c.nx).toBeCloseTo(1, 6);
    expect(c.depth).toBeCloseTo(0.6, 6);
    expect(circleVsObb(0, 2.3, 0.5, { x: 0, z: 0, hw: 1, hl: 2, h: 0 }, c)).toBe(true);
    expect(c.nz).toBeCloseTo(1, 6);
    expect(c.depth).toBeCloseTo(0.2, 6);
    expect(circleVsObb(0, 2.6, 0.5, { x: 0, z: 0, hw: 1, hl: 2, h: 0 }, c)).toBe(false);
    expect(circleVsCircle(0, 0, 1, 0, 0, 1, c)).toBe(true);
    expect(Number.isFinite(c.nx)).toBe(true);
  });
});

describe('ray tests', () => {
  it('hits boxes, cylinders and oriented boxes', () => {
    expect(rayAabb3(-10, 1, 0, 1, 0, 0, -1, 0, -1, 1, 2, 1, 100)).toBeCloseTo(9, 6);
    expect(rayAabb3(-10, 3, 0, 1, 0, 0, -1, 0, -1, 1, 2, 1, 100)).toBe(-1);
    expect(rayAabb3(0, 1, 0, 1, 0, 0, -1, 0, -1, 1, 2, 1, 100)).toBe(0);
    expect(rayCylinderY(-10, 1, 0, 1, 0, 0, 0, 0, 0.5, 0, 2, 100)).toBeCloseTo(9.5, 6);
    expect(rayCylinderY(0, 10, 0.2, 0, -1, 0, 0, 0, 0.5, 0, 2, 100)).toBeCloseTo(8, 6);
    expect(rayCylinderY(-10, 1, 0.6, 1, 0, 0, 0, 0, 0.5, 0, 2, 100)).toBe(-1);
    const t = rayObb3(-10, 0.5, 0, 1, 0, 0, { x: 0, z: 0, hw: 1, hl: 2, h: Math.PI / 2 }, 0, 1.5, 100);
    expect(t).toBeCloseTo(8, 6); // rotated 90 degrees: the long axis now lies along X
  });

  it('grid raycast matches brute force', () => {
    const rng = new Rng(42);
    const grid = new StaticGrid(-200, -200, 200, 200, 12);
    for (let i = 0; i < 400; i++) {
      const x = rng.range(-190, 190);
      const z = rng.range(-190, 190);
      if (rng.chance(0.5)) grid.addBox(x, z, x + rng.range(1, 30), z + rng.range(1, 30), 0, rng.range(2, 60), 'building');
      else grid.addCircle(x, z, rng.range(0.2, 2), 0, rng.range(1, 8), 'tree');
    }
    const hit = makeRayHit();
    for (let k = 0; k < 3000; k++) {
      const ox = rng.range(-220, 220);
      const oy = rng.range(0.5, 30);
      const oz = rng.range(-220, 220);
      let dx = rng.range(-1, 1);
      let dy = rng.range(-0.3, 0.3);
      let dz = rng.range(-1, 1);
      if (k % 50 === 0) {
        dx = 0;
        dz = 0;
        dy = -1;
      }
      const l = Math.hypot(dx, dy, dz);
      dx /= l;
      dy /= l;
      dz /= l;
      const maxD = rng.range(5, 400);
      let best = Infinity;
      for (const c of grid.colliders) {
        const t = c.circle
          ? rayCylinderY(ox, oy, oz, dx, dy, dz, c.cx, c.cz, c.r, c.y0, c.y1, maxD)
          : rayAabb3(ox, oy, oz, dx, dy, dz, c.minX, c.y0, c.minZ, c.maxX, c.y1, c.maxZ, maxD);
        // The grid only covers its bounds; colliders were generated inside it.
        if (t >= 0 && t < best) best = t;
      }
      const got = grid.raycast(ox, oy, oz, dx, dy, dz, maxD, hit);
      if (best === Infinity) {
        expect(got, `ray ${k}`).toBe(false);
      } else {
        expect(got, `ray ${k}`).toBe(true);
        expect(hit.t).toBeCloseTo(best, 6);
      }
    }
  });
});
