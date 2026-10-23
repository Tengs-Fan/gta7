// Keeps the job vehicles standing ready: an ambulance at San Azura General and a fire truck at the station beside SAPD
// Central (places.ts depots). One is put there, out of the player's sight, whenever its depot is empty; one he drives
// away becomes an ordinary car. Only in sims made with serviceVehicles (the game's), so headless runs are unchanged.

import type { Vehicle } from '../entities';
import type { Sim } from '../sim';
import { VEHICLE_SPECS } from '../specs';
import { registerSystem } from '../systems';
import { clearOfVehicles } from '../vehicleRoom';
import { places } from './places';

/** The depot is restocked only with the player this far off (m) and the spot out of his sight. */
const RESTOCK_DIST = 45;
/** A depot vehicle driven this far (m) from its depot is the player's to keep. */
const TAKEN_DIST = 30;
const CHECK_FRAMES = 30;

const parked = new WeakMap<Sim, Array<Vehicle | null>>();

/** The vehicles standing at the depots now (null for an empty depot), in places().depots order. */
export function depotVehicles(sim: Sim): ReadonlyArray<Vehicle | null> {
  return parked.get(sim) ?? [];
}

function restock(sim: Sim): void {
  const depots = places(sim.world).depots;
  let held = parked.get(sim);
  if (!held) {
    held = depots.map(() => null);
    parked.set(sim, held);
  }
  depots.forEach((d, i) => {
    const v = held![i];
    if (v) {
      const gone = v.removed || v.destroyed || (v.usedByPlayer && Math.hypot(v.pos.x - d.x, v.pos.z - d.z) > TAKEN_DIST);
      if (!gone) return;
      if (!v.removed) v.persistent = false;
      held![i] = null;
    }
    if (sim.distToPlayer(d.x, d.z) < RESTOCK_DIST || sim.isVisible(d.x, 1, d.z)) return;
    if (!clearOfVehicles(sim, d.kind, d.x, d.z, d.heading)) return;
    const car = sim.spawnVehicle(d.kind, d.x, d.z, d.heading, VEHICLE_SPECS[d.kind].colors[0]);
    // Kept while it waits: abandoned cars far from the player are streamed out.
    car.persistent = true;
    held![i] = car;
  });
}

registerSystem({
  id: 'serviceVehicles',
  slot: 'late',
  update(sim) {
    if (sim.serviceVehicles && sim.frame % CHECK_FRAMES === 1) restock(sim);
  },
  reset(sim) {
    parked.delete(sim);
  },
});
