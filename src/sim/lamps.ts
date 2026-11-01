// A vehicle's lamps: the one rule for whether they are lit, shared by the sim (a press of the headlight switch flips what
// the player sees) and the renderer (the lenses, glows, headlight pools and the player's spot).

import { darkness } from './clock';
import type { Vehicle } from './entities';

/** In `auto`, the lamps come on when the dark passes this (sim/clock.ts darkness, or the weather's dim if that is darker). */
export const LAMPS_DARK = 0.35;

/** How dark it is for lamps: the night, or an overcast day's dim (sim/weather.ts) if that is darker. */
export function lampDarkness(hours: number, weatherDim: number): number {
  return Math.max(darkness(hours), weatherDim);
}

/** Parked, abandoned and wrecked vehicles keep their lamps dark: a driver aboard (or a deployed police car's siren) powers them. */
export function lampsPowered(v: Pick<Vehicle, 'destroyed' | 'driver' | 'siren'>): boolean {
  return !v.destroyed && (v.driver !== null || v.siren);
}

/** Whether the lamps are lit at a `dark` (see lampDarkness): the switch decides, `auto` by the dark, and unpowered lamps never. */
export function lampsLit(v: Pick<Vehicle, 'destroyed' | 'driver' | 'siren' | 'lights'>, dark: number): boolean {
  return lampsPowered(v) && (v.lights === 'on' || (v.lights === 'auto' && dark > LAMPS_DARK));
}
