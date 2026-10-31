// Ambient cars that hold each other up in a junction (two nose to nose, three crossing it) used to wait the full
// 9 s before any of them backed out, and the second clash after that pushed single cars past the 20 s stuck limit
// of the 5-minute traffic soak (research/gameplay/traffic.measure.ts). Same scene as the soak: the player pinned on
// a corner pavement, slowly panning, police off.

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import type { SimOptions } from '../../src/sim/sim';
import { input, makeSim, teleport } from './helpers';

/** Longest `stuckTime` of any ambient car within 130 m of the corner after `seconds`. */
function worstStuck(opts: Pick<SimOptions, 'seed' | 'streetCrime'>, node: [number, number], seconds: number): number {
  const sim = makeSim({ ambient: true, police: false, startHour: 17, ...opts });
  const n = sim.roads.node(node[0], node[1]);
  const x = n.x + n.halfX + 3;
  const z = n.z + n.halfZ + 3;
  teleport(sim, x, z);
  const p = sim.player;
  const dt = 1 / 60;
  let yaw = 0;
  let worst = 0;
  for (let f = 0; f < Math.round(seconds / dt); f++) {
    p.pos.x = x;
    p.pos.z = z;
    yaw += dt * 0.15;
    const d = { x: Math.sin(yaw), y: -0.1, z: Math.cos(yaw) };
    sim.update(dt, input({ cameraYaw: yaw, aimDir: d, aimOrigin: { x: x - d.x * 4.3, y: p.pos.y + 2.6, z: z - d.z * 4.3 } }));
    if (f % 30 !== 0) continue;
    for (const v of sim.vehicles) {
      if (v.removed || !v.ai || !v.driver || v.driver.isPlayer || v.destroyed) continue;
      if (Math.hypot(v.pos.x - x, v.pos.z - z) > 130) continue;
      worst = Math.max(worst, v.stuckTime);
    }
  }
  return worst;
}

describe('ambient traffic never stays stuck over 20 s', () => {
  it('street crime on, seed 11 at node (4,7): the sedan that stalled 22 s clears the junction', () => {
    expect(worstStuck({ seed: 11, streetCrime: true }, [4, 7], 100)).toBeLessThanOrEqual(20);
  });

  it('street crime off, seed 3 at node (8,5): three cars crossing one junction clear it', () => {
    expect(worstStuck({ seed: 3 }, [8, 5], 120)).toBeLessThanOrEqual(20);
  });

  it('street crime off, seed 11 at node (5,5): two taxis nose to nose clear it', () => {
    expect(worstStuck({ seed: 11 }, [5, 5], 150)).toBeLessThanOrEqual(20);
  });
});

// Las Lomas County's stop signs (docs/map.md): ten minutes at each of the Creek T and the Hollister T, the player on the
// verge slowly looking round, police off, at noon and the game's own traffic (all of it within reach of the junction).
// Every car that stops at a stop line goes within 30 s, and no two vehicles collide in either junction. Across seeds
// 1-12 nothing collided in either; the longest wait was 39 s, and 4 of the 24 runs passed 30 s (a turn left from the
// country road needs a gap in both streams at once). At 1.5 times the traffic the Creek T's left turns waited up to 85 s.
describe('stop signs never jam', () => {
  function soak(name: 'creek' | 'hollister', at: [number, number], seed: number): { worst: number; stops: number; crashes: number; through: number } {
    const sim = makeSim({ ambient: true, police: false, startHour: 12, seed });
    const roads = sim.roads;
    const node = roads.junction(name);
    const box = (x: number, z: number) => Math.abs(x - node.x) < node.halfX + 2 && Math.abs(z - node.z) < node.halfZ + 2;
    let crashes = 0;
    const impact = sim.onVehicleImpact.bind(sim);
    sim.onVehicleImpact = (v, other, deltaV, x, z, ...rest) => {
      if (other && deltaV > 2 && box(x, z)) crashes++;
      impact(v, other, deltaV, x, z, ...rest);
    };
    const [x, z] = at;
    teleport(sim, x, z);
    const p = sim.player;
    const waits = new Map<Vehicle, number>();
    const stopped = new Set<Vehicle>();
    const through = new Set<Vehicle>();
    let worst = 0;
    let yaw = 0;
    for (let f = 0; f < 10 * 3600; f++) {
      p.pos.x = x;
      p.pos.z = z;
      yaw += (1 / 60) * 0.15;
      const d = { x: Math.sin(yaw), y: -0.1, z: Math.cos(yaw) };
      sim.update(1 / 60, input({ cameraYaw: yaw, aimDir: d, aimOrigin: { x: x - d.x * 4.3, y: p.pos.y + 2.6, z: z - d.z * 4.3 } }));
      if (f % 30 !== 0) continue;
      for (const v of sim.vehicles) {
        if (v.removed || !v.ai || !v.driver || v.driver.isPlayer || v.destroyed) continue;
        const lane = v.ai.currentLane();
        const atLine = lane !== null && lane.to === node.id && roads.stopsAt(lane) && lane.length - ((v.pos.x - lane.sx) * lane.dx + (v.pos.z - lane.sz) * lane.dz) - v.halfL < 6;
        if (atLine && v.speed < 0.5) {
          waits.set(v, (waits.get(v) ?? 0) + 0.5);
          stopped.add(v);
        } else waits.delete(v);
        if (stopped.has(v) && box(v.pos.x, v.pos.z)) through.add(v);
        worst = Math.max(worst, waits.get(v) ?? 0);
      }
    }
    return { worst, stops: stopped.size, crashes, through: through.size };
  }

  it('ten minutes at the Creek T, seed 2: no wait at its line over 30 s, no collision in it', () => {
    const r = soak('creek', [-866, 286], 2);
    console.log(`[stop_sign soak] Creek T: ${r.stops} cars stopped at the line, ${r.through} went on, longest wait ${r.worst.toFixed(1)} s, ${r.crashes} collisions in the junction`);
    expect(r.stops).toBeGreaterThan(20);
    expect(r.through).toBeGreaterThanOrEqual(r.stops - 3);
    expect(r.worst).toBeLessThanOrEqual(30);
    expect(r.crashes).toBe(0);
  }, 300_000);

  it('ten minutes at the Hollister T, seed 8: no wait at its line over 30 s, no collision in it', () => {
    const r = soak('hollister', [-1130, -290], 8);
    console.log(`[stop_sign soak] Hollister T: ${r.stops} cars stopped at the line, ${r.through} went on, longest wait ${r.worst.toFixed(1)} s, ${r.crashes} collisions in the junction`);
    expect(r.stops).toBeGreaterThan(20);
    expect(r.through).toBeGreaterThanOrEqual(r.stops - 3);
    expect(r.worst).toBeLessThanOrEqual(30);
    expect(r.crashes).toBe(0);
  }, 300_000);
});
