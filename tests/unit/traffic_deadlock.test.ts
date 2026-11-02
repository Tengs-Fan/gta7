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

// Las Lomas County's stop signs (docs/map.md): ten minutes at each of the Creek T, the Hollister T and the Coyote T,
// seeds 1-12, and at Valley Cross, seeds 1-4, the player on the verge slowly looking round, police off, at noon and the
// game's own traffic (all of it within reach of the junction). Every car that stops at a stop line goes on through the
// junction within 40 s (but for those still at the line when the ten minutes end), and no two vehicles collide in any
// junction. Over each junction's seeds at least MIN_THROUGH cars stop at its line and go on: 467 at the Creek T, 745 at
// the Hollister T, 229 at the Coyote T (7 to 20 cars stop at its line in each of its seventeen runs) and 156 at Valley
// Cross. The bound is 40 s, not 30: a left turn from the country road needs a gap in both of the highway's streams at
// once, and the longest wait across the 24 runs at the Creek T and the Hollister T is 34 s (3 of 1223 stops waited over
// 30 s). No cheap rule tried (shorter gaps, sooner impatience, a forced go) got the longest under 36 s without
// collisions in the box, and the traffic's density never goes above 1.0 in play (at 1.5 times the traffic the Creek T's
// left turns waited up to 85 s).
// At the Coyote T a left turn waits out the platoons behind the highway's tractors, and a tractor turning needs longer
// gaps: its seventeen runs here wait at most 35 s, and over seeds 1-400 two waited over 40 s (49 s, a tractor turning
// left, and 40.5 s), none over 50 s.
// The Coyote T also runs seeds 108, 143, 304, 326 and 336: there, and at seed 8, a highway left turner was hit in the T
// by a car spawned at speed 60-105 m up the highway after it had judged its gap (8, 108 and 336 with the old 50 m spawn
// clearance, 143, 304, 326 and 336 with a county yield 1.8 m short of the lane's end), about one run in a hundred, too
// rare for twelve seeds to see. Since the spawner keeps a left turn's time off those lanes (spawnClearance) they are
// five more seeds; seeds 1-400 had no collision in the T.
type Soaked = 'creek' | 'hollister' | 'coyote' | 'valley';

describe('stop signs never jam', () => {
  /** `parked`: where a car is left standing, from the junction's centre. */
  function soak(name: Soaked, at: [number, number], seed: number, parked?: [number, number]): { worst: number; stops: number; crashes: number; through: number; there: number } {
    const sim = makeSim({ ambient: true, police: false, startHour: 12, seed });
    const roads = sim.roads;
    const node = roads.junction(name);
    if (parked) sim.spawnVehicle('sedan', node.x + parked[0], node.z + parked[1], Math.PI / 2).owner = 'parked';
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
    // Stopped at the line and not through yet: still at it, or pulling out of it, when the ten minutes end (within 30 m of
    // the centre, as every stop line is).
    const there = [...stopped].filter((v) => !through.has(v) && !v.removed && Math.hypot(v.pos.x - node.x, v.pos.z - node.z) < 30).length;
    return { worst, stops: stopped.size, crashes, through: through.size, there };
  }

  const first = (n: number) => Array.from({ length: n }, (_, k) => k + 1);
  const SEEDS: Readonly<Record<Soaked, readonly number[]>> = { creek: first(12), hollister: first(12), coyote: [...first(12), 108, 143, 304, 326, 336], valley: first(4) };
  /**
   * The fewest cars that stop at each line in ten minutes (the Coyote T sees too few in one run for a floor to say much),
   * and the fewest that stop at it and go on through the junction over all its seeds: about three standard deviations
   * under what as many seeds average in a sweep of 60-400 of them.
   */
  const MIN_STOPS: Readonly<Partial<Record<Soaked, number>>> = { creek: 20, hollister: 20, valley: 20 };
  const MIN_THROUGH: Readonly<Record<Soaked, number>> = { creek: 400, hollister: 690, coyote: 180, valley: 120 };
  /** The cars that stopped at each line and went on, over the seeds run so far. */
  const wentOn: Record<Soaked, number> = { creek: 0, hollister: 0, coyote: 0, valley: 0 };
  const RUNS = (Object.keys(SEEDS) as Soaked[]).flatMap((name) => SEEDS[name].map((seed) => [name, seed] as const));
  const AT: Readonly<Record<Soaked, [number, number]>> = { creek: [-866, 286], hollister: [-1130, -290], coyote: [-1356, 106], valley: [-1866, 106] };
  const TITLE = { creek: 'the Creek T', hollister: 'the Hollister T', coyote: 'the Coyote T', valley: 'Valley Cross' } as const;

  it.each(RUNS)('ten minutes at %s, seed %i: every car that stops at its line goes on, none waits over 40 s, no collision in it', (name, seed) => {
    const r = soak(name, AT[name], seed);
    wentOn[name] += r.through;
    console.log(`[stop_sign soak] ${TITLE[name]}, seed ${seed}: ${r.stops} cars stopped at the line, ${r.through} went on, ${r.there} still there at the end, longest wait ${r.worst.toFixed(1)} s, ${r.crashes} collisions in the junction`);
    expect(r.stops).toBeGreaterThanOrEqual(MIN_STOPS[name] ?? 0);
    expect(r.through + r.there).toBe(r.stops);
    expect(r.worst).toBeLessThanOrEqual(40);
    expect(r.crashes).toBe(0);
  }, 300_000);

  // Run after all of a junction's runs above (a file's tests run in order), so a -t that picks this and only some of
  // them fails it.
  it.each(Object.keys(SEEDS) as Soaked[])('%s, over all its seeds: at least its floor of cars stop at its line and go on', (name) => {
    console.log(`[stop_sign soak] ${TITLE[name]}, ${SEEDS[name].length} seeds: ${wentOn[name]} cars stopped at the line and went on`);
    expect(wentOn[name]).toBeGreaterThanOrEqual(MIN_THROUGH[name]);
  });

  // A car left standing on the verge inside the Creek T's box (10 m from its centre) is in nobody's way: counted as
  // traffic in the junction it held every car on Creek Road at the line for the whole ten minutes.
  it('ten minutes at the Creek T, seed 1, a car parked on the verge in its box: no wait at its line over 40 s', () => {
    const r = soak('creek', AT.creek, 1, [0, 9.5]);
    console.log(`[stop_sign soak] the Creek T, seed 1, a car parked in the box: ${r.stops} cars stopped at the line, ${r.through} went on, ${r.there} still there at the end, longest wait ${r.worst.toFixed(1)} s, ${r.crashes} collisions in the junction`);
    expect(r.stops).toBeGreaterThan(20);
    expect(r.through + r.there).toBe(r.stops);
    expect(r.worst).toBeLessThanOrEqual(40);
    expect(r.crashes).toBe(0);
  }, 300_000);
});
