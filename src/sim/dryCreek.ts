// Gas & Grits in Dry Creek (world/country/places.ts): a pump knocked down, by a car or a blast, goes up a moment later
// and leaves a fire burning under the canopy. Its blast knocks down the pumps within PUMP_REACH of it, so the forecourt
// goes up one pump after another, PUMP_CHAIN s apart. Each pump goes once (a new game stands them up again), which caps
// the chain.

import type { Character } from './entities';
import type { Sim } from './sim';
import { registerSystem } from './systems';

/** Seconds from a pump's falling to its blast, and at least this long between two blasts. */
export const PUMP_FUSE = 0.4;
export const PUMP_CHAIN = 0.3;
/** A pump's blast: its radius (m) and damage, and how far off it knocks down the other pumps. */
export const PUMP_BLAST = { radius: 8, damage: 110 };
export const PUMP_REACH = 13;
/** The blast is the doing of the nearest player within this many metres of the pump (the one who rammed or shot it). */
const CULPRIT_REACH = 40;

interface Forecourt {
  pumps: ReadonlySet<number>;
  /** The pumps down and waiting to go, by prop index, and when (sim time). */
  lit: Array<{ prop: number; at: number }>;
}

const forecourts = new WeakMap<Sim, Forecourt>();

function forecourt(sim: Sim): Forecourt {
  let f = forecourts.get(sim);
  if (!f) {
    const fresh: Forecourt = { pumps: new Set(sim.world.layout.country.places.town.pumps), lit: [] };
    sim.events.on('propBroken', (e) => {
      if (!fresh.pumps.has(e.index)) return;
      const last = fresh.lit.at(-1)?.at ?? -Infinity;
      fresh.lit.push({ prop: e.index, at: Math.max(sim.time + PUMP_FUSE, last + PUMP_CHAIN) });
    });
    f = fresh;
    forecourts.set(sim, f);
  }
  return f;
}

function culprit(sim: Sim, x: number, z: number): Character | null {
  let best: Character | null = null;
  let bd = CULPRIT_REACH;
  for (const slot of sim.players) {
    const p = slot.character;
    const d = Math.hypot(p.pos.x - x, p.pos.z - z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

registerSystem({
  id: 'dryCreek',
  slot: 'afterCombat',
  update(sim) {
    const f = forecourt(sim);
    while (f.lit.length > 0 && f.lit[0]!.at <= sim.time) {
      const world = sim.world;
      const p = world.layout.props[f.lit.shift()!.prop]!;
      const who = culprit(sim, p.x, p.z);
      sim.combat.explosion(p.x, p.y + 1, p.z, PUMP_BLAST.radius, PUMP_BLAST.damage, who, null);
      sim.combat.fire.ignite(p.x, p.y, p.z, who);
      for (const i of f.pumps) {
        const q = world.layout.props[i]!;
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d > PUMP_REACH) continue;
        // The blast's own reach may have knocked it down already.
        if (world.breakCollider(world.grid.colliders[world.propColliders[i]!]!) >= 0) sim.events.emit('propBroken', { index: i, dirX: (q.x - p.x) / d, dirZ: (q.z - p.z) / d });
      }
    }
  },
  reset(sim) {
    forecourts.delete(sim);
  },
});
