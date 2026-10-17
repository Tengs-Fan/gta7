// Cheat codes are typed as plain letters during play. These helpers tell how far into a code the
// typed letters are, so Input can keep the keys of a code being typed from also acting as bindings.

/** Every cheat code, upper case. */
export const CHEAT_CODES = ['CHILLOUT', 'GUNSGALORE', 'FIXMYRIDE', 'IMMORTAL', 'MONEYTREE', 'SUNSET', 'NIGHTOWL', 'SPAWNSPORTS', 'COPMAGNET'] as const;

export type CheatCode = (typeof CHEAT_CODES)[number];

/** A cheat code typed, and the key presses that typed its letters (numbered by Input, see Input.screenKeyPress). */
export interface TypedCheat {
  code: CheatCode;
  presses: readonly number[];
}

const LONGEST = Math.max(...CHEAT_CODES.map((c) => c.length));

/** Length of the longest suffix of `typed` (upper case) that begins a cheat code: how far into a code the player is. */
export function cheatPrefixLength(typed: string): number {
  for (let n = Math.min(typed.length, LONGEST); n > 0; n--) {
    const tail = typed.slice(typed.length - n);
    if (CHEAT_CODES.some((c) => c.startsWith(tail))) return n;
  }
  return 0;
}

/** The cheat code `typed` (upper case) ends with, if any. */
export function completedCheat(typed: string): CheatCode | null {
  return CHEAT_CODES.find((c) => typed.endsWith(c)) ?? null;
}
