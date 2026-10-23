// What the cheat codes do to the sim. Single player only: a multiplayer sim refuses every one (cheatRefusal).
// FIXMYRIDE is the game's own (it undoes the exit its F asked for), apart from the refusal.

import type { PlayerSlot } from './playerSlot';
import type { Sim } from './sim';
import { WEAPON_ORDER } from './specs';
import { findVehicleRoom } from './vehicleRoom';
import type { WeatherKind } from './weather';

/** Why cheats do nothing in a multiplayer sim. */
export const MP_NO_CHEATS = 'Cheats are off in multiplayer.';

/** RAINDANCE steps the weather through these, then back to the forecast (null); each change ramps over CHEAT_RAMP s. */
export const RAINDANCE: ReadonlyArray<WeatherKind | null> = ['rain', 'storm', 'overcast', 'clear', null];
export const CHEAT_RAMP = 6;

/** Why no cheat takes effect in `sim` (a multiplayer sim), or null in single player. */
export function cheatRefusal(sim: Sim): string | null {
  return sim.multiplayer ? MP_NO_CHEATS : null;
}

/**
 * Applies cheat `code` to `slot`'s player (slot 0 by default). Returns the refusal (multiplayer) or null; an unknown
 * code, or one the sim does not handle (FIXMYRIDE), changes nothing.
 */
export function applySimCheat(sim: Sim, code: string, slot: PlayerSlot = sim.players[0]!): string | null {
  const refused = cheatRefusal(sim);
  if (refused) return refused;
  const p = slot.character;
  switch (code) {
    case 'CHILLOUT':
      slot.wanted.clear();
      break;
    case 'GUNSGALORE':
      for (const w of WEAPON_ORDER) if (w !== 'fists') p.inventory.give(w, 300);
      break;
    case 'IMMORTAL':
      slot.cheats.godMode = !slot.cheats.godMode;
      break;
    case 'MONEYTREE':
      slot.progress.addMoney(50000);
      sim.events.emit('money', { amount: 50000, ...slot.tag });
      break;
    case 'SUNSET':
      sim.clock.set(18.3);
      break;
    case 'NIGHTOWL':
      sim.clock.set(23);
      break;
    case 'SPAWNSPORTS': {
      const fx = Math.sin(p.heading);
      const fz = Math.cos(p.heading);
      // In front of him where it fits: clear of walls and props, and of the cars and people there (him too).
      const spot = findVehicleRoom(sim, 'sports', p.pos.x + fx * 6, p.pos.z + fz * 6, p.heading, 20);
      if (spot) sim.spawnVehicle('sports', spot.x, spot.z, p.heading);
      break;
    }
    case 'COPMAGNET':
      slot.wanted.setLevel(Math.min(5, slot.wanted.level + 2));
      break;
    case 'RAINDANCE': {
      const next = RAINDANCE[(RAINDANCE.indexOf(sim.weather.overridden) + 1) % RAINDANCE.length] ?? null;
      sim.weather.override(next, CHEAT_RAMP);
      break;
    }
  }
  return null;
}
