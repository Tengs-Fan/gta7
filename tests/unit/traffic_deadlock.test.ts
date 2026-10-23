// Ambient cars that hold each other up in a junction (two nose to nose, three crossing it) used to wait the full
// 9 s before any of them backed out, and the second clash after that pushed single cars past the 20 s stuck limit
// of the 5-minute traffic soak (research/gameplay/traffic.measure.ts). Same scene as the soak: the player pinned on
// a corner pavement, slowly panning, police off.

import { describe, expect, it } from 'vitest';
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
