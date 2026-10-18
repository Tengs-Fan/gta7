// Fix pass 5, world: the Ferris wheel on Azura Pier no longer stands an invisible 8 x 12 x 4 m wall on the open deck under
// it. Walkers, cars, shots and the camera pass under the wheel to the pier's far end; only its legs, which stand in the sea
// beside the deck, are solid (where they meet the water). The drawing side (the legs meet the hub, the gondolas clear a
// bus, the posts stand on the drawn legs) is in r2_fix5_props.test.ts.

import { describe, expect, it } from 'vitest';
import { WATER_Y } from '../../src/world/constants';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

const ferris = () => world().layout.props.find((p) => p.kind === 'ferris')!;
const pier = () => world().layout.decks.find((d) => d.name === 'Azura Pier')!;

describe('the open deck under the Ferris wheel', () => {
  it('the wheel stands where the pier is open, past the middle of its length', () => {
    const f = ferris();
    const d = pier();
    expect(f.x).toBeGreaterThan(d.rect.minX + 100);
    expect(f.x).toBeLessThan(d.rect.maxX - 12);
    expect(f.z).toBeCloseTo((d.rect.minZ + d.rect.maxZ) / 2, 6);
  });

  it('a walker going east along the pier passes under the wheel, on the middle line and off it', () => {
    const f = ferris();
    const bad: string[] = [];
    for (const z of [36, 40, 44]) {
      const sim = makeSim({ police: false });
      teleport(sim, f.x - 30, z);
      step(sim, 10, input({ moveZ: 1, cameraYaw: Math.PI / 2 }));
      const p = sim.player.pos;
      if (p.x < f.x + 4.5 || Math.abs(p.y - pier().y) > 0.01) bad.push(`z ${z}: stopped at x ${p.x.toFixed(2)}, y ${p.y.toFixed(2)}`);
    }
    expect(bad).toEqual([]);
  });

  it('a car driven east along the pier passes under the wheel without a crash and reaches the far end', () => {
    const f = ferris();
    const bad: string[] = [];
    for (const kind of ['sedan', 'sports', 'bus'] as const) {
      const sim = makeSim({ police: false });
      const v = sim.spawnVehicle(kind, f.x - 32, f.z, Math.PI / 2);
      placeInCar(sim, v);
      v.vel.x = 15;
      const hp = v.health;
      let impacts = 0;
      sim.events.on('impact', (e) => {
        if (e.vehicle === v) impacts++;
      });
      let past = false;
      step(sim, 5, () => {
        if (v.pos.x > f.x + 8) past = true;
        // About 15 m/s under the wheel, then braking to a stop before the end of the pier (not on into reverse).
        const fwd = v.vel.x * Math.sin(v.heading) + v.vel.z * Math.cos(v.heading);
        return past ? input({ brake: fwd > 0.5 ? 1 : 0, handbrake: fwd <= 0.5 }) : input({ throttle: fwd < 15 ? 1 : 0 });
      });
      const end = pier().rect.maxX;
      if (!past || impacts > 0 || v.health < hp || v.inWater || v.pos.x > end || v.speed > 0.5) bad.push(`${kind}: at x ${v.pos.x.toFixed(2)} (the pier ends at ${end}), ${v.speed.toFixed(1)} m/s, ${impacts} impacts, health ${v.health.toFixed(0)}/${hp}${v.inWater ? ', in the sea' : ''}`);
    }
    expect(bad).toEqual([]);
  });

  it('shots, the camera and line of sight pass under the wheel, and the deck there is free to stand on', () => {
    const W = world();
    const f = ferris();
    for (const y of [0.6, 1.45, 2.5, 4]) expect(W.lineOfSight(f.x - 10, pier().y + y, f.z, f.x + 10, pier().y + y, f.z), `at ${y} m over the deck`).toBe(true);
    for (const z of [34.5, 36, 40, 44, 45.5]) expect(W.isFree(f.x, z, 0.4), `(${f.x}, ${z})`).toBe(true);
    // No collider over the deck within 4 m of the wheel's plane (the old wall's length), up to the gondolas' lowest point.
    const d = pier().rect;
    const over = W.grid.colliders.filter((c) => c.maxX > f.x - 4 && c.minX < f.x + 4 && c.maxZ > d.minZ && c.minZ < d.maxZ && c.y1 > pier().y && c.y0 < pier().y + 3.9);
    expect(over.map((c) => `${c.tag} x ${c.minX}..${c.maxX} z ${c.minZ}..${c.maxZ} y ${c.y0}..${c.y1}`)).toEqual([]);
  });

  it('its four legs are solid where they stand in the sea, beside the deck: a swimmer bumps into one', () => {
    const W = world();
    const f = ferris();
    const d = pier().rect;
    const i = W.layout.props.indexOf(f);
    const legs = W.grid.colliders.filter((c) => c.tag === 'pillar' && Math.abs(c.cx - f.x) < 8 && Math.abs(c.cz - f.z) < 20);
    expect(legs.length).toBe(4);
    expect(legs.map((c) => c.id)).toContain(W.propColliders[i]);
    for (const c of legs) {
      expect(c.circle).toBe(true);
      expect(c.cz < d.minZ - 3 || c.cz > d.maxZ + 3, `leg at z ${c.cz}`).toBe(true);
      expect(W.waterDepth(c.cx, c.cz)).toBeGreaterThan(5);
      // Through a swimmer's whole band (sim/characterPhysics: feet 1.3 m under the surface, 0.35 m up to the body).
      expect(c.y0).toBeLessThan(WATER_Y - 1.3);
      expect(c.y1).toBeGreaterThan(WATER_Y + 0.6);
    }
    const leg = legs.find((c) => c.cz < f.z && c.cx < f.x)!;
    const sim = makeSim({ police: false });
    teleport(sim, leg.cx, leg.cz - 6);
    step(sim, 6, input({ moveZ: 1, cameraYaw: 0 }));
    const p = sim.player.pos;
    expect(sim.player.state).toBe('swimming');
    expect(Math.hypot(p.x - leg.cx, p.z - leg.cz)).toBeGreaterThan(leg.r + sim.player.radius - 0.05);
    expect(p.z).toBeLessThan(leg.cz);
  });
});
