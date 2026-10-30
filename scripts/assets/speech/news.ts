// Every sentence the Azura Newsdesk can read (src/audio/newsText.ts): its tables, the ones that name a place once per
// place the city names, the leads and arrivals once per part of the day. build.ts renders each as its own clip.

import { AGAIN, ARRIVAL, CARS_LOST, CHASE_KICKERS, CHASE_LEADS, DAYPARTS, FIRE_KICKERS, FOLLOW_UP, HELD, HELI_DOWN, OPENERS, OUTCOMES, PLACED, PROMISED, SIGN_OFFS, SKY_NOW, STEADY, SUNK_KICKERS, TOMORROW, WEATHER_OPENERS, WHEN } from '../../../src/audio/newsText';

export function newsSentences(zones: readonly string[]): string[] {
  const when = DAYPARTS.map((d) => WHEN[d]);
  return [
    ...new Set([
      ...OPENERS,
      ...Object.values(AGAIN).flatMap((a) => [a.today, a.yesterday]),
      FOLLOW_UP,
      ...SIGN_OFFS,
      ...CHASE_LEADS.flatMap((lead) => when.map(lead)),
      ...Object.values(PLACED).flatMap((line) => zones.map(line)),
      HELI_DOWN,
      ...Object.values(OUTCOMES).flat(),
      ...CHASE_KICKERS,
      ...SUNK_KICKERS,
      ...CARS_LOST,
      ...FIRE_KICKERS,
      ...WEATHER_OPENERS,
      ...Object.values(SKY_NOW).flat(),
      ...Object.values(ARRIVAL).flatMap((line) => when.map(line)),
      ...STEADY,
      ...Object.values(TOMORROW),
      ...Object.values(PROMISED),
      ...Object.values(HELD).flat(),
    ]),
  ];
}
