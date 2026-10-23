// Boats moored at the Marina: a speedboat and a dinghy wait along the finger pier nearest the Marina, streamed like the
// parked cars. One appears at its mooring once the player is within MOOR_RANGE of it (the first time even in view;
// after that, a mooring left empty is filled again out of his sight); an untouched one goes with the traffic streaming
// once he is far away. Only in sims with ambient life.

import { WATER_Y } from '../world/constants';
import type { StaticWorld } from '../world/staticWorld';
import type { Vehicle } from './entities';
import type { Sim } from './sim';
import { VEHICLE_SPECS, type VehicleKind } from './specs';
import type { SimSystem } from './systems';

export interface Mooring {
  kind: VehicleKind;
  x: number;
  z: number;
  heading: number;
  color: number;
}

/** Within this distance (m) of a mooring its boat is there (traffic streaming removes boats left alone past 200 m). */
export const MOOR_RANGE = 180;
/** Gap between a moored hull and its pier (m): close enough to step aboard. */
const PIER_GAP = 1.0;
/** How often (s) the moorings are checked. */
const CHECK_EVERY = 0.5;

/**
 * The Marina's moorings: along the west side of the finger pier nearest the Marina's POI, the dinghy near the main deck
 * and the speedboat further out, both pointing out to sea (+z). The moored prop boats lie on the piers' east sides.
 */
export function marinaMoorings(world: StaticWorld): Mooring[] {
  const poi = world.layout.pois.find((p) => p.kind === 'marina');
  if (!poi) return [];
  let pier: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
  let best = Infinity;
  for (const d of world.layout.decks) {
    const r = d.rect;
    if (d.name !== 'Marina' || r.maxX - r.minX > 8 || r.maxZ - r.minZ < 20) continue;
    const dd = Math.hypot((r.minX + r.maxX) / 2 - poi.x, r.minZ - poi.z);
    if (dd < best) {
      best = dd;
      pier = r;
    }
  }
  if (!pier) return [];
  const at = (kind: VehicleKind, along: number): Mooring => {
    const s = VEHICLE_SPECS[kind];
    return { kind, x: pier!.minX - PIER_GAP - s.width / 2, z: pier!.minZ + along, heading: 0, color: s.colors[0]! };
  };
  return [at('dinghy', 8), at('speedboat', 21)];
}

interface MarinaState {
  moorings: Mooring[];
  boats: (Vehicle | null)[];
  filled: boolean[];
  next: number;
}

const states = new WeakMap<Sim, MarinaState>();

/** The boat now at each of `sim`'s moorings (null where there is none), for tests and the debug surface. */
export function mooredBoats(sim: Sim): (Vehicle | null)[] {
  return states.get(sim)?.boats.slice() ?? [];
}

export const MARINA_SYSTEM: SimSystem = {
  id: 'marina',
  slot: 'afterTraffic',
  update(sim) {
    if (!sim.ambient) return;
    let st = states.get(sim);
    if (!st) {
      const moorings = marinaMoorings(sim.world);
      st = { moorings, boats: moorings.map(() => null), filled: moorings.map(() => false), next: 0 };
      states.set(sim, st);
    }
    if (sim.time < st.next) return;
    st.next = sim.time + CHECK_EVERY;
    const pp = sim.playerPos();
    // With several players any of them near the Marina brings its boats (slot 0 may be parked or across town).
    const multi = sim.players.length > 1;
    for (let i = 0; i < st.moorings.length; i++) {
      const m = st.moorings[i]!;
      const b = st.boats[i];
      // Taken (by the player: no longer moored), sunk or streamed away: the mooring is free again.
      if (b && (b.removed || b.owner !== 'moored')) st.boats[i] = null;
      if (st.boats[i]) continue;
      if ((multi ? sim.distToPlayer(m.x, m.z) : Math.hypot(m.x - pp.x, m.z - pp.z)) > MOOR_RANGE) continue;
      if (st.filled[i] && sim.isVisible(m.x, WATER_Y + 0.5, m.z)) continue;
      const len = VEHICLE_SPECS[m.kind].length;
      if (sim.vehicles.some((o) => !o.removed && Math.hypot(o.pos.x - m.x, o.pos.z - m.z) < len)) continue;
      const v = sim.spawnVehicle(m.kind, m.x, m.z, m.heading, m.color);
      v.pos.y = WATER_Y;
      v.owner = 'moored';
      st.boats[i] = v;
      st.filled[i] = true;
    }
  },
  reset(sim) {
    states.delete(sim);
  },
};
