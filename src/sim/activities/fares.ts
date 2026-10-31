// Who rides in the cab: a few fare types, each with its own voice (cast in scripts/assets/speech/script.ts), the same
// voice the hail is shouted in (BARKS.hail). The type is picked by the character's id, so no random draw is spent.

export interface Fare {
  /** The subtitle's name, and the speaker the dialogue index voices. */
  speaker: string;
  /** Getting in: where to. */
  ask(place: string): string;
  /** Let out at the stop, paid. */
  paid: string;
  /** Getting out of a trip that took too long. */
  late: string;
}

export const FARES: readonly Fare[] = [
  { speaker: 'Commuter', ask: (p) => `${p}, and step on it. I'm already late.`, paid: 'Made it. Barely. Thanks.', late: "Forget it. I'll walk." },
  { speaker: 'Tourist', ask: (p) => `Hello! Could you take me to ${p}, please?`, paid: 'Lovely! Thank you, driver!', late: "This is taking ages. I'll find my own way." },
  { speaker: 'Local', ask: (p) => `${p}. And skip the scenic route, okay?`, paid: 'Not bad. Not bad at all.', late: "I could've walked faster. So I'm walking." },
];

/** The fare type of a character: by id, the same index his shouts pick their voice by (barks.ts). */
export function fareOf(c: { id: number }): Fare {
  return FARES[c.id % FARES.length]!;
}
