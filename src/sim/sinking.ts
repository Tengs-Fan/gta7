// The people in a car that goes down in deep water: the player swims out (PlayerController.ejectPlayer); everyone else
// gets out into the water beside it and either swims for it or drowns a few seconds later. Each NPC's fate is fixed by
// his id (DROWN_SHARE of them drown), so same-seed runs agree. A drowning is a death by 'drown' charged to the player
// when he was at the wheel as the car went in (a kill and its crime, like any other he causes), to no one otherwise.

import { makeBrain } from './brains';
import type { Character, Vehicle } from './entities';
import type { Sim } from './sim';
import type { SimSystem } from './systems';

/** Share of NPC occupants who do not make it out, and how long (s) after the car goes in they go under. */
export const DROWN_SHARE = 0.35;
export const DROWN_AFTER = 3;

interface Drowning {
  c: Character;
  at: number;
  culprit: Character | null;
}

const pending = new WeakMap<Sim, Drowning[]>();

/** Whether `c` drowns when his car sinks (fixed by his id). */
export function drownsInSinkingCar(c: Character): boolean {
  let h = Math.imul(c.id + 0x9e37, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) % 1000 < DROWN_SHARE * 1000;
}

/**
 * `v` has just gone into deep water: its NPC occupants climb out into the water beside it (to swim, or to drown
 * DROWN_AFTER s later, charged to `culprit`: the player who drove it in, or null). The player is left to the caller.
 */
export function abandonSinkingCar(sim: Sim, v: Vehicle, npcs: readonly Character[], culprit: Character | null): void {
  const sx = Math.cos(v.heading);
  const sz = -Math.sin(v.heading);
  let list = pending.get(sim);
  if (!list) pending.set(sim, (list = []));
  for (const c of npcs) {
    const side = c.seat % 2 === 0 ? 1 : -1;
    sim.unseat(c);
    const spot = sim.world.findFreeSpot(v.pos.x + sx * side * (v.halfW + 0.8), v.pos.z + sz * side * (v.halfW + 0.8), 0.4, 4, true) ?? { x: v.pos.x, z: v.pos.z };
    c.pos.x = spot.x;
    c.pos.z = spot.z;
    c.pos.y = Math.max(sim.world.groundHeight(spot.x, spot.z), v.pos.y);
    c.vel.x = 0;
    c.vel.y = 0;
    c.vel.z = 0;
    c.onGround = false;
    c.state = 'normal';
    if (c.owner === 'traffic') c.owner = 'ped';
    // He swims for the shore: away from the player who drove him in, or on his way otherwise.
    if (culprit) sim.peds.onJacked(c, culprit);
    else if (!c.brain) c.brain = makeBrain('wander');
    if (drownsInSinkingCar(c)) list.push({ c, at: sim.time + DROWN_AFTER, culprit });
  }
}

export const SINKING_SYSTEM: SimSystem = {
  id: 'sinking',
  slot: 'afterPhysics',
  update(sim) {
    const list = pending.get(sim);
    if (!list || list.length === 0) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i]!;
      if (sim.time < d.at && !d.c.removed) continue;
      list.splice(i, 1);
      if (d.c.removed || !d.c.alive) continue;
      sim.combat.damageCharacter(d.c, d.c.health + d.c.armor + 1000, d.culprit, 'drown', 0, -1, 0);
    }
  },
  reset(sim) {
    pending.delete(sim);
  },
};
