// Who rides in the cab: a few fare types, each with its own voice (cast in scripts/assets/speech/script.ts), the same
// voice the hail is shouted in (BARKS.hail). The type is picked by the character's id among the types of his or her
// sex (appearance.ts isWoman), so no random draw is spent and the one who gets in looks as the fare sounds.

import { isWoman } from '../appearance';
import type { CharacterRole } from '../entities';

export interface Fare {
  /** The subtitle's name, and the speaker the dialogue index voices. */
  speaker: string;
  /** Whether that voice is a woman's. */
  woman: boolean;
  /** Getting in: where to. */
  ask(place: string): string;
  /** Let out at the stop, paid. */
  paid: string;
  /** Getting out of a trip that took too long. */
  late: string;
}

export const FARES: readonly Fare[] = [
  { speaker: 'Commuter', woman: false, ask: (p) => `${p}, and step on it. I'm already late.`, paid: 'Made it. Barely. Thanks.', late: "Forget it. I'll walk." },
  { speaker: 'Tourist', woman: true, ask: (p) => `Hello! Could you take me to ${p}, please?`, paid: 'Lovely! Thank you, driver!', late: "This is taking ages. I'll find my own way." },
  { speaker: 'Local', woman: true, ask: (p) => `${p}. And skip the scenic route, okay?`, paid: 'Not bad. Not bad at all.', late: "I could've walked faster. So I'm walking." },
];

/** The fare type of a character: by id among the types of his or her sex, as a shout picks its voice (barks.ts barkVoice). */
export function fareOf(c: { id: number; role: CharacterRole }): Fare {
  const woman = isWoman(c);
  const own = FARES.filter((f) => f.woman === woman);
  return own[c.id % own.length]!;
}
