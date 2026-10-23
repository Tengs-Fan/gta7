// Shared setup for the chapter 2 (Vera Salgado) tests.

import { expect } from 'vitest';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { MissionCtx } from '../../src/sim/missions/runner';
import type { Sim } from '../../src/sim/sim';
import { aimAt, input, makeSim, step, teleport } from './helpers';

export const CHAPTER1 = ['wheels', 'delivery', 'repo', 'loose_lips', 'heatwave', 'big_score'];
export const CHAPTER2 = ['shadow_play', 'room_service', 'showroom', 'off_the_road', 'rush_hour', 'last_call'];

/** A sim with every mission before `id` done (story order), god mode on. */
export function storySim(id: string, opts: { god?: boolean } = {}): Sim {
  const sim = makeSim({ ambient: false });
  const all = [...CHAPTER1, ...CHAPTER2];
  for (const m of all.slice(0, all.indexOf(id))) sim.progress.markDone(m);
  sim.cheats.godMode = opts.god ?? true;
  step(sim, 0.1);
  return sim;
}

export function active(sim: Sim): MissionCtx {
  const m = sim.missions.active;
  expect(m, 'a mission is running').not.toBeNull();
  return m!;
}

/** Walks onto the contact marker and presses E, as a player would. */
export function startAtMarker(sim: Sim, id: string): void {
  const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === id);
  expect(marker, `marker for ${id}`).toBeDefined();
  teleport(sim, marker!.x, marker!.z);
  step(sim, 0.1);
  sim.update(1 / 60, input({ interact: true }));
  expect(sim.missions.active?.def.id).toBe(id);
}

/** Steps until the predicate holds, or fails after `max` seconds; `each` runs before every frame (a bot). */
export function stepUntil(sim: Sim, pred: () => boolean, max: number, each?: () => ReturnType<typeof input> | void): number {
  let t = 0;
  for (; t < max; t += 1 / 60) {
    if (pred()) return t;
    const inp = each?.() ?? input();
    sim.update(1 / 60, inp);
  }
  expect(pred(), 'condition not reached in time').toBe(true);
  return t;
}

export function objectiveIs(sim: Sim, text: string | RegExp): () => boolean {
  return () => {
    const o = sim.missions.active?.objectiveText ?? '';
    return typeof text === 'string' ? o === text : text.test(o);
  };
}

export function enterVehicle(sim: Sim, v: Vehicle): void {
  if (sim.player.vehicle === v) return;
  if (sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
  const sx = Math.cos(v.heading);
  const sz = -Math.sin(v.heading);
  teleport(sim, v.pos.x + sx * (v.halfW + 0.8), v.pos.z + sz * (v.halfW + 0.8));
  sim.update(1 / 60, input({ enterExit: true }));
  stepUntil(sim, () => sim.player.vehicle === v, 3);
}

/** Puts the player's car at (x, z), stopped. */
export function parkAt(sim: Sim, x: number, z: number, heading?: number): void {
  const v = sim.player.vehicle!;
  v.pos.x = x;
  v.pos.z = z;
  v.pos.y = sim.world.groundHeight(x, z);
  v.vel.x = 0;
  v.vel.z = 0;
  v.angVel = 0;
  if (heading !== undefined) v.heading = heading;
}

/** Bot input that shoots the nearest of `targets` still standing (aims at the chest, fires every few frames). */
export function gunner(sim: Sim, targets: () => Character[]): () => ReturnType<typeof input> {
  let f = 0;
  return () => {
    f++;
    const p = sim.playerPos();
    let best: Character | null = null;
    let bd = Infinity;
    for (const c of targets()) {
      if (c.removed || !c.alive) continue;
      const dd = Math.hypot(c.pos.x - p.x, c.pos.z - p.z);
      if (dd < bd) {
        bd = dd;
        best = c;
      }
    }
    if (!best) return input();
    const fire = f % 6 === 0;
    return aimAt(sim, { x: best.pos.x, y: best.pos.y + 1.2, z: best.pos.z }, { aim: true, fire, firePressed: fire });
  };
}

export const missionEntities = (sim: Sim, tag: string) => ({
  vehicles: sim.vehicles.filter((v) => !v.removed && v.missionTag === tag).length,
  characters: sim.characters.filter((c) => !c.removed && c.persistent && c.owner === 'mission').length,
});
