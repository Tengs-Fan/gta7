// What the Azura Newsdesk says (Dolores Vance on AZURA TALK, newsroom.ts): the player's chases, the cars he sinks and
// burns, his missions and the weather, as whole sentences. Each sentence is recorded on its own (scripts/assets/speech/
// news.ts lists them all from the tables here), and a bulletin is read by joining them at sentence boundaries, so the
// tables are everything the desk can say. Pure: the speech build imports it too.

import type { Forecast, WeatherKind } from '../sim/weather';

export type Daypart = 'morning' | 'afternoon' | 'evening' | 'tonight';
export type Outcome = 'evaded' | 'busted' | 'wasted';

/**
 * What happened, at `at` game hours on the clock's time line (day * 24 + hours). A mission's bulletin is its opener
 * and sign-off: its recorded piece (SPEECH.missionNews) is read between them. A weather desk reads the sky now and the
 * forecast: null while the weather is held (`held` says by what), absent on a view without one.
 */
export type Story =
  | { kind: 'chase'; at: number; stars: number; from: string; to: string; heli: boolean; outcome: Outcome }
  | { kind: 'sunk'; at: number; zone: string }
  | { kind: 'fire'; at: number; zone: string; cars: number }
  | { kind: 'mission'; at: number; id: string; later: boolean }
  | { kind: 'weather'; at: number; sky: WeatherKind; forecast?: Forecast | null; held?: 'clear' | 'override' }
  | { kind: 'promised'; at: number; sky: WeatherKind };

/** Draws one of a table's variants: the Newsroom keeps a Bag per table, so a kicker comes round again only after every other one has. */
export interface Bags {
  draw(pool: readonly string[]): string;
}

/** How the desk puts each place the city names (zoneNames, scripts/assets/speech/phrases.ts) after a verb. */
export const ZONE_PREP: Readonly<Record<string, string>> = {
  'San Azura Bay': 'in San Azura Bay',
  'Ocean Beach': 'on Ocean Beach',
  Hillcrest: 'in Hillcrest',
  'Hillcrest Green': 'in Hillcrest Green',
  Westside: 'in Westside',
  Midtown: 'in Midtown',
  Downtown: 'downtown',
  'Azura Park': 'in Azura Park',
  'Civic Plaza': 'at Civic Plaza',
  'Port Azura Docks': 'in the Port Azura Docks',
  Southgate: 'in Southgate',
  'Southgate Square': 'in Southgate Square',
  'Cortez Canal': 'in the Cortez Canal',
  'Gull Bay': 'in Gull Bay',
  'Northshore Bay': 'in Northshore Bay',
  'Pelican Harbor': 'in Pelican Harbor',
  'Coral Bay': 'in Coral Bay',
  'Azura Pier': 'on Azura Pier',
  Marina: 'at the Marina',
  'Hillcrest Cove': 'in Hillcrest Cove',
  'Port Basin': 'in Port Basin',
  'Azura Point': 'at Azura Point',
  'Hollister Farm': 'at Hollister Farm',
  'Eternal Palms Cemetery': 'at Eternal Palms Cemetery',
  "Smuggler's Key": "on Smuggler's Key",
};

/** The place on its own ('the Marina', 'downtown'): its phrase without the preposition. */
const place = (zone: string): string => ZONE_PREP[zone]!.replace(/^(in|on|at) /, '');

export const DAYPARTS: readonly Daypart[] = ['morning', 'afternoon', 'evening', 'tonight'];
export const WHEN: Readonly<Record<Daypart, string>> = { morning: 'this morning', afternoon: 'this afternoon', evening: 'this evening', tonight: 'tonight' };

/** Morning 5-12, afternoon 12-17, evening 17-21, tonight 21-5. */
export function daypart(hours: number): Daypart {
  const h = ((hours % 24) + 24) % 24;
  return h < 5 ? 'tonight' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'tonight';
}

/** A story from before the desk's day turned: last night's, or yesterday's. */
export const BEFORE: Readonly<Record<'night' | 'day', string>> = { night: 'last night', day: 'yesterday' };

/**
 * When a story at `at` happened, said at `now`: its part of the day while the desk's day lasts, then BEFORE. The
 * desk's day turns at 5 in the morning, when tonight ends: a chase at 2 is tonight's until then, last night's after.
 */
export function ago(at: number, now: number): string {
  const d = daypart(at);
  return Math.floor((now - 5) / 24) === Math.floor((at - 5) / 24) ? WHEN[d] : BEFORE[d === 'tonight' ? 'night' : 'day'];
}

export const OPENERS: readonly string[] = ['Breaking news from the Azura Newsdesk.', 'This just in.', 'News just in at the Azura Newsdesk.'];

/** A story's second airing opens on it by name: the story of today, or of yesterday when the day has turned since. */
export const AGAIN: Readonly<Record<'chase' | 'sunk' | 'fire' | 'mission', { today: string; yesterday: string }>> = {
  chase: { today: "More now on today's police chase.", yesterday: "More now on yesterday's police chase." },
  sunk: { today: 'More now on the car that went into the water today.', yesterday: 'More now on the car that went into the water yesterday.' },
  fire: { today: "More now on today's car fire.", yesterday: "More now on yesterday's car fire." },
  mission: { today: 'More now on a story we brought you earlier.', yesterday: 'More now on a story we brought you yesterday.' },
};

/** The opener of a mission's follow-up, a day or more after it. */
export const FOLLOW_UP = 'And an update on a story we have been following.';

export const SIGN_OFFS: readonly string[] = ['Back to you, Chet.', "That's the news. Back to you, Chet.", 'Dolores Vance, Azura Newsdesk. Back to you, Chet.'];

/** A chase's lead by its most stars (2 or 3, 4, 5), and when it happened (ago). */
export const CHASE_LEADS: readonly ((when: string) => string)[] = [
  (w) => `A police chase tore across San Azura ${w}.`,
  (w) => `SWAT vans joined a police chase across the city ${w}.`,
  (w) => `The entire San Azura police department chased one driver ${w}.`,
];

/** The sentences that name a place. */
export const PLACED = {
  started: (zone: string) => `It started ${ZONE_PREP[zone]!}.`,
  ended: (zone: string) => `It ended ${ZONE_PREP[zone]!}.`,
  stayed: (zone: string) => `It never left ${place(zone)}.`,
  sunk: (zone: string) => `A car went into the water ${ZONE_PREP[zone]!}.`,
  fire: (zone: string) => `Fire crews were called to a blaze ${ZONE_PREP[zone]!}.`,
};

export const HELI_DOWN = 'The police helicopter did not make it home.';

export const OUTCOMES: Readonly<Record<Outcome, readonly string[]>> = {
  evaded: ['The suspect got away.', 'The suspect got away, and police say they are not angry, just disappointed.'],
  busted: ['The suspect is in custody, and has asked for Morty Fenwick.', 'Police made an arrest, and the suspect has asked for a lawyer and a sandwich, in that order.'],
  wasted: ['The suspect was taken to San Azura General.', 'The suspect is at San Azura General, where doctors describe him as, quote, still talking.'],
};

export const CHASE_KICKERS: readonly string[] = [
  'Police describe the driver as, quote, extremely annoying.',
  'Witnesses say the car was going very fast, and mostly the wrong way.',
  'Police remind drivers that a red light is not a suggestion.',
  'One witness called it the most exciting thing to happen in San Azura since the rubber ducks.',
  'The department has asked residents to stop cheering from their balconies.',
  'Officers say they were this close, and they are holding their fingers very close together.',
  'A hot dog vendor along the route reports record sales.',
  'Police say the suspect used his turn signal exactly once, and they found it insulting.',
  'City Hall says the potholes did everything they could.',
  'Insurance companies across the city have asked for a moment of silence.',
  'The department would like its hubcaps back.',
  'Police say the chase used up a whole week of overtime, and most of the donuts.',
];

export const SUNK_KICKERS: readonly string[] = [
  'Divers recovered the car, and a very surprised crab.',
  'The Harbor Patrol reminds drivers that the bay is not a parking space.',
  'Witnesses say it floated for a moment, with great dignity.',
  'Police say the driver swam out, and did not look back.',
  'Local fish are said to be furious.',
  'Marine biologists say it is already becoming a reef.',
];

/** How many cars burned: two to eight, then nine or more. */
export const CARS_LOST: readonly string[] = [
  'Two cars were destroyed.',
  'Three cars were destroyed.',
  'Four cars were destroyed.',
  'Five cars were destroyed.',
  'Six cars were destroyed.',
  'Seven cars were destroyed.',
  'Eight cars were destroyed.',
  'Nine or more cars were destroyed, and the fire chief has stopped counting.',
];

export const FIRE_KICKERS: readonly string[] = [
  'The fire chief described the scene as, quote, a lot of fire.',
  'Neighbors say the smoke could be seen from Hillcrest.',
  'Firefighters ask whoever is doing this to please stop. They are tired.',
  'Fire crews were back at the station in time for lunch, and then called out again.',
];

export const WEATHER_OPENERS: readonly string[] = ['And now your weather.', "Here's your Azura weather.", 'Time for the weather, which is not my fault.'];

export const SKY_NOW: Readonly<Record<WeatherKind, readonly string[]>> = {
  clear: ['Right now, clear skies over San Azura.', 'Right now, not a cloud over the city.'],
  cloudy: ['Right now, a few clouds over San Azura.', 'Right now, partly cloudy, and partly not.'],
  overcast: ['Right now, grey skies over the whole city.', 'Right now, a lid of grey over San Azura.'],
  rain: ['Right now, rain across San Azura.', "Right now, it's raining, so drive like you have brakes."],
  storm: ['Right now, a storm over the city.', 'Right now, thunder and lightning over San Azura, so stay off the pier.'],
};

/** The next change of weather today, by its kind and when it comes. */
export const ARRIVAL: Readonly<Record<WeatherKind, (when: string) => string>> = {
  clear: (w) => `Clear skies on the way ${w}.`,
  cloudy: (w) => `Clouds rolling in ${w}.`,
  overcast: (w) => `Grey skies moving in ${w}.`,
  rain: (w) => `Rain moving in ${w}.`,
  storm: (w) => `A storm rolling in off the bay ${w}.`,
};

/** No change for the rest of the day. */
export const STEADY: readonly string[] = ['No change expected for the rest of the day.', 'More of the same for the rest of the day.'];

export const TOMORROW: Readonly<Record<WeatherKind, string>> = {
  clear: 'Tomorrow looks sunny.',
  cloudy: 'Tomorrow looks cloudy.',
  overcast: 'Tomorrow looks grey.',
  rain: 'Tomorrow looks wet.',
  storm: 'Tomorrow looks stormy.',
};

/** The forecast change has come, as the desk said it would. */
export const PROMISED: Readonly<Record<WeatherKind, string>> = {
  clear: "As promised, the sun is out. You're welcome.",
  cloudy: "As promised, the clouds are here. You're welcome.",
  overcast: "As promised, the sky has gone grey. You're welcome.",
  rain: "As promised, the rain is here. You're welcome.",
  storm: "As promised, the storm is here. You're welcome, and stay indoors.",
};

/** The weather is held: always clear by the setting, or forced by a cheat. */
export const HELD: Readonly<Record<'clear' | 'override', readonly string[]>> = {
  clear: ['City Hall has banned weather until further notice.', 'Our weather team has been told to stop predicting anything else.'],
  override: ['Our weather computer has been overruled by, and I quote, a rain dance.', 'Our forecast has been cancelled. Someone out there is doing the weather by hand.', 'The sky is no longer taking questions.'],
};

/** The chase lead's star bucket: 2 or 3 stars, 4, 5. */
const bucket = (stars: number): number => (stars >= 5 ? 2 : stars >= 4 ? 1 : 0);

/**
 * The sentences of a story's bulletin, airing at `now` (game hours on the time line). A second airing (`again`) opens
 * on the story by name and skips the lead; it draws a new kicker.
 */
export function bulletin(story: Story, now: number, bags: Bags, again = false): string[] {
  // The second airing names the calendar day ("today's police chase" of one at 3 in the morning); the lead, the desk's.
  const day = Math.floor(now / 24) === Math.floor(story.at / 24) ? 'today' : 'yesterday';
  const signOff = () => bags.draw(SIGN_OFFS);
  switch (story.kind) {
    case 'chase': {
      const route = story.from === story.to ? [PLACED.stayed(story.from)] : [PLACED.started(story.from), PLACED.ended(story.to)];
      const lead = again ? [AGAIN.chase[day]] : [bags.draw(OPENERS), CHASE_LEADS[bucket(story.stars)]!(ago(story.at, now))];
      return [...lead, ...route, ...(story.heli ? [HELI_DOWN] : []), bags.draw(OUTCOMES[story.outcome]), bags.draw(CHASE_KICKERS), signOff()];
    }
    case 'sunk':
      return [...(again ? [AGAIN.sunk[day]] : [bags.draw(OPENERS), PLACED.sunk(story.zone)]), bags.draw(SUNK_KICKERS), signOff()];
    case 'fire': {
      const lost = CARS_LOST[Math.min(story.cars, 9) - 2]!;
      return [...(again ? [AGAIN.fire[day]] : [bags.draw(OPENERS), PLACED.fire(story.zone), lost]), bags.draw(FIRE_KICKERS), signOff()];
    }
    case 'mission':
      return [again ? AGAIN.mission[day] : story.later ? FOLLOW_UP : bags.draw(OPENERS), signOff()];
    case 'weather': {
      const f = story.forecast;
      const ahead = f === undefined ? [] : f === null ? [bags.draw(HELD[story.held!])] : [f.next ? ARRIVAL[f.next.kind](WHEN[daypart(f.next.startHours)]) : bags.draw(STEADY), TOMORROW[f.tomorrow]];
      return [bags.draw(WEATHER_OPENERS), bags.draw(SKY_NOW[story.sky]), ...ahead, signOff()];
    }
    case 'promised':
      return [bags.draw(WEATHER_OPENERS), PROMISED[story.sky], signOff()];
  }
}
