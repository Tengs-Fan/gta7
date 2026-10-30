// What the game says out loud, apart from the mission dialogue (read from the mission scripts, see dialogue.ts) and the
// police dispatch phrases (built from the dispatch tables, see build.ts): the cast, the talk station's programme and the
// barks of people in the street. Every line is original. Voices are Kokoro-82M voice ids (see README.md here).

import type { BarkKind, ShowId, TalkKind } from '../../../src/sim/speech';

/**
 * Kokoro voice per role. American voices start with a, British with b; f and m are female and male. A comma-separated
 * list is a blend: Kokoro averages the voices (the language is the first one's).
 */
export const CAST = {
  lou: 'af_bella',
  dex: 'bm_george',
  vera: 'bf_emma',
  dispatch: 'af_nova',
  chet: 'am_puck',
  dolores: 'af_sarah',
  skip: 'am_michael',
  announcer: 'am_fenrir',
  ident: 'af_heart',
  gary: 'am_echo',
  linda: 'af_jessica',
  marcus: 'am_liam',
  doris: 'bf_lily',
  vince: 'am_onyx',
  jen: 'af_river',
  morty: 'bm_lewis',
  kid: 'af_sky',
  ron: 'am_onyx,am_fenrir',
  nate: 'am_eric',
  sal: 'am_santa',
  pembury: 'bm_lewis,bm_daniel',
  reginald: 'bm_daniel',
  pru: 'bf_emma,bf_lily',
  marjorie: 'bf_alice,bf_isabella',
  sam: 'am_michael,am_adam',
  marguerite: 'af_nicole,af_bella',
  lefty: 'am_santa,am_echo',
  lyle: 'bm_fable',
  trish: 'af_kore',
  reader: 'af_alloy',
} as const;

export type Role = keyof typeof CAST;

/**
 * How Kokoro is told to say a word it gets wrong (its inline phoneme markup, or a respelling); the index keeps the
 * written line. Azura is ah-ZOO-ra everywhere, not "as you're a".
 */
export const SAY: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bAzura\b/g, '[Azura](/ɑzˈuɹə/)'],
  [/\bCitybus\b/g, 'City bus'],
  [/\bReginald\b/g, 'Redginald'],
  [/\bAshcombe\b/g, 'Ashkum'],
  [/\bMarguerite\b/g, '[Marguerite](/mˌɑɹɡəɹˈit/)'],
  [/\bSzabo\b/g, 'Sahbo'],
  [/\bTruett\b/g, 'Trooett'],
];

/** Talk station roles heard down a phone line or a radio link: their lines are band-limited when rendered. */
export const PHONE_ROLES: ReadonlySet<Role> = new Set<Role>(['gary', 'linda', 'marcus', 'doris', 'vince', 'jen', 'kid', 'skip', 'sal', 'trish']);

/** Mission speakers (the subtitle's name without " (phone)") and the role that voices them. */
export const SPEAKERS: Readonly<Record<string, Role>> = {
  'Mama Lou': 'lou',
  'Dex Moreau': 'dex',
  'Vera Salgado': 'vera',
};

/** How one line is delivered, where it differs from its piece's: a fine-print line read fast, a caller in the studio. */
export interface LineOpts {
  /** Kokoro's speed (default 1.05 in an ad, else 1). */
  speed?: number;
  /** Band-limited to a phone line (default: the role is in PHONE_ROLES). */
  phone?: boolean;
}

export type Line = readonly [Role, string, LineOpts?];

export interface TalkPiece {
  id: string;
  kind: TalkKind;
  /** The show it belongs to (default 'azura'). */
  show?: ShowId;
  /** An ad: every show whose breaks may play it (default [show]). */
  shows?: readonly ShowId[];
  /** An ad campaign's name and this piece's place in it, from 1: a break plays the campaign's next part. */
  series?: string;
  part?: number;
  /** The lines in order; a piece is rendered as one clip with short pauses between speakers. */
  lines: ReadonlyArray<Line>;
}

/** AZURA TALK 104.5: Chet Bramble's show, Dolores Vance's newsdesk, Skip in the Skycopter, callers and ads. */
export const TALK: readonly TalkPiece[] = [
  // Chet Bramble, alone at the microphone.
  {
    id: 'host-lights',
    kind: 'host',
    lines: [
      ['chet', "Good morning, good afternoon, whatever it is, San Azura! This is Chet Bramble on Azura Talk, and I have a question nobody at City Hall wants to answer."],
      ['chet', "Why are the traffic lights in Midtown green for exactly four seconds? I timed it. Four seconds. You can't even finish a sneeze in four seconds."],
      ['chet', "Meanwhile some guy in a Nightjar runs the red at ninety, and the light says, sure, why not. I'm not saying the lights are rigged. I'm saying I've seen the guy who programs them, and he drives a Nightjar."],
    ],
  },
  {
    id: 'host-wheel',
    kind: 'host',
    lines: [
      ['chet', "Folks, I went down to Azura Pier this weekend. Beautiful day. I paid eleven dollars to ride the Ferris wheel, and at the top, the very top, it stopped. For twenty minutes."],
      ['chet', "The operator yells up, enjoy the view! Buddy, I enjoyed it. I enjoyed it so hard I could see my house in Hillcrest, and my house could see me, and we were both disappointed."],
      ['chet', "Eleven dollars. For eleven dollars I want the wheel to go around. That's the whole product. It's in the name."],
    ],
  },
  {
    id: 'host-steps',
    kind: 'host',
    lines: [
      ['chet', "Let's talk about health. My doctor says I need to get my steps in. So I bought a treadmill. It's in the garage, holding up four boxes of Christmas lights and a bicycle I also bought to get my steps in."],
      ['chet', "You know who gets their steps in? The guys running from the cops in Southgate. Every night on the news, a man in flip-flops outrunning three cruisers and a helicopter."],
      ['chet', "That man is an athlete. Somebody get him a sponsor."],
    ],
  },
  {
    id: 'host-gulls',
    kind: 'host',
    lines: [
      ['chet', "Here's something that keeps me up at night. The seagulls at Ocean Beach. They're organized now."],
      ['chet', "I watched one distract a family with a sad little limp, while two of his buddies took an entire club sandwich. Three layers, San Azura. They planned it."],
      ['chet', "I've worked with people who couldn't plan a lunch order, and these birds pulled off a heist. Lock up your fries, people. The gulls are watching."],
    ],
  },
  {
    id: 'host-rent',
    kind: 'host',
    lines: [
      ['chet', "I got my rent notice today. Up again. My landlord says the neighborhood is up and coming. Up and coming! There was a car on fire on my street last Tuesday."],
      ['chet', "Nobody called anybody. We just stood around it, warming our hands. That's community, I guess. The fire truck came and went, and the rent went up the next morning."],
      ['chet', "Coincidence? I'm just asking questions."],
    ],
  },
  {
    id: 'host-potholes',
    kind: 'host',
    lines: [
      ['chet', "The mayor announced a brand new plan for the potholes on the ring road. The plan is, and I am reading this directly, to encourage drivers to embrace the journey."],
      ['chet', "Embrace the journey! I embraced the journey yesterday and lost a hubcap and two fillings."],
      ['chet', "Here's my plan, Mister Mayor. Fill the holes. With anything. Gravel. Concrete. Old parking tickets. Lord knows this city has enough of those."],
    ],
  },
  {
    id: 'host-chopper',
    kind: 'host',
    lines: [
      ['chet', "I want to talk about the news helicopter. Every night, live footage, some maniac doing donuts outside the Azura Bowl with four police cars behind him."],
      ['chet', "And I'll be honest with you. I watch the whole thing. I make popcorn. And when they finally box him in, I'm disappointed!"],
      ['chet', "What does that say about me? What does that say about this city? Don't answer that. The phone lines are open."],
    ],
  },
  {
    id: 'host-cab',
    kind: 'host',
    lines: [
      ['chet', "Took an Azura Cab across town today. The driver had this very station on, so first of all, great taste."],
      ['chet', "Second of all, he drove the wrong way down a one-way street, and when I said something, he said, it's only one way if you think about it."],
      ['chet', "I have been thinking about that for six hours. I don't know if that man is a genius or if I need a lawyer. Probably both."],
    ],
  },
  {
    id: 'host-docks',
    kind: 'host',
    lines: [
      ['chet', "Somebody explain the Port Azura Docks to me. Every container is the same color. Every crane is the same crane. And every night, somehow, something goes missing."],
      ['chet', "Last week it was ten thousand rubber ducks. Who steals rubber ducks? Where do you sell them? Is there a black market for bath toys?"],
      ['chet', "If you know, call in. I won't judge. I'll judge a little."],
    ],
  },

  // Callers.
  {
    id: 'call-lighthouse',
    kind: 'call',
    lines: [
      ['chet', "Line two, you're on Azura Talk."],
      ['gary', "Hey Chet, Gary from the Westside, long time listener. I saw something over the lighthouse last night. A big light, going round and round."],
      ['chet', "Gary. That's the lighthouse."],
      ['gary', "That's what they want you to think."],
      ['chet', "Gary, it has been doing that for a hundred years."],
      ['gary', "Exactly. Patient. Very patient."],
      ['chet', "Thank you, Gary. Stay safe. Stay inside."],
    ],
  },
  {
    id: 'call-pickup',
    kind: 'call',
    lines: [
      ['chet', "Linda in Hillcrest, go ahead."],
      ['linda', "Chet, some guy keeps parking a bright yellow pickup across my driveway."],
      ['chet', "Have you talked to him?"],
      ['linda', "I left a note. He left a note back. It said, no."],
      ['chet', "Just no?"],
      ['linda', "Just no. Underlined. Twice."],
      ['chet', "Linda, that is a man at peace with himself. You have to respect it. Or call a tow truck. I would call a tow truck."],
    ],
  },
  {
    id: 'call-tacos',
    kind: 'call',
    lines: [
      ['chet', "Marcus, you're on the air."],
      ['marcus', "Chet, I run a little taco truck by Southgate Square, and every night two crews come to my window. The Tiburones and the Halcones."],
      ['chet', "Are they trouble?"],
      ['marcus', "No, man, they're my best customers. Problem is, they won't stand in the same line. So now I got two lines, two menus, and I painted the truck two colors."],
      ['chet', "Marcus, that's diplomacy. That's the United Nations of tacos."],
      ['marcus', "Al pastor brings people together, Chet."],
    ],
  },
  {
    id: 'call-cat',
    kind: 'call',
    lines: [
      ['chet', "Doris, hello, you're on Azura Talk."],
      ['doris', "Hello, Chet? My cat has climbed to the top of Moreau Tower."],
      ['chet', "Ma'am, that is forty floors."],
      ['doris', "Forty two. He took the stairs. He's very determined."],
      ['chet', "Did you call the fire department?"],
      ['doris', "They said he looked happy up there. He has a better view than I do. I just wanted someone to know."],
      ['chet', "Well, now all of San Azura knows. Wave to him, folks."],
    ],
  },
  {
    id: 'call-velora',
    kind: 'call',
    lines: [
      ['chet', "Vince, go ahead."],
      ['vince', "Yeah, I just want to say something to whoever stole my Velora from outside the bank today."],
      ['chet', "Go on."],
      ['vince', "I hope you enjoy the air freshener. It's cinnamon. It's very strong."],
      ['chet', "Any message for the police?"],
      ['vince', "Take your time. Honestly, the brakes were going."],
    ],
  },
  {
    id: 'call-houseboat',
    kind: 'call',
    lines: [
      ['chet', "Jen, you're on the air."],
      ['jen', "Chet, my boyfriend wants us to move onto a houseboat at the Marina."],
      ['chet', "Do you like boats?"],
      ['jen', "I get seasick in the bath."],
      ['chet', "Then the answer is simple, Jen. Keep the bath. Get a new boyfriend."],
    ],
  },
  {
    id: 'call-kid',
    kind: 'call',
    lines: [
      ['chet', "Line four, you're on Azura Talk."],
      ['kid', "Hi! Is this the radio?"],
      ['chet', "It is the radio. How old are you?"],
      ['kid', "Eight. My dad says you yell at clouds."],
      ['chet', "Your dad is a smart man. Put him on."],
      ['kid', "He's driving. He's yelling at a bus."],
      ['chet', "That's my guy. Drive safe, dad."],
    ],
  },

  // Newsdesk, traffic, weather and sports.
  {
    id: 'news-ducks',
    kind: 'news',
    lines: [
      ['dolores', "This is Dolores Vance with the Azura Newsdesk. City council has voted to rename the ring road the scenic loop, after a survey found that drivers spend most of their day looking at it."],
      ['dolores', "At the docks, a shipment of ten thousand rubber ducks was reported missing. Police say they have no leads, but several suspects have been seen floating near the Marina."],
      ['dolores', "And the Azura Bowl confirms this weekend's game will go ahead, even though the new scoreboard spells home with two m's. More at the top of the hour."],
    ],
  },
  {
    id: 'news-thefts',
    kind: 'news',
    lines: [
      ['dolores', "Police are asking for help after a string of car thefts across the city. Witnesses describe the suspect as in a hurry, and really good at driving."],
      ['dolores', "SAPD believes the cars are taken to a garage, possibly in the docks, possibly owned by a woman who calls everybody baby."],
      ['dolores', "If you have information, officers ask that you call it in during business hours. They are very busy."],
    ],
  },
  {
    id: 'news-weather',
    kind: 'news',
    lines: [
      ['dolores', "And now your weather. Sunny over Ocean Beach, highs in the upper eighties, and a strong chance of sunburn."],
      ['dolores', "A sea breeze picks up this afternoon, so hold on to your hats, your umbrellas and your small dogs."],
      ['dolores', "Storms may roll in off the bay tonight. If you hear thunder, it's either the weather or the Westside drag races. Possibly both."],
    ],
  },
  {
    id: 'news-sports',
    kind: 'news',
    lines: [
      ['dolores', "In sports, the San Azura Gulls lost again at the Azura Bowl, forty two to three. The coach says the team showed a lot of heart, and almost no legs."],
      ['dolores', "Fans responded by doing the wave for the other team. The Gulls are now on a twelve game losing streak, which the club calls a rebuilding era, and everyone else calls the Gulls."],
    ],
  },
  {
    id: 'traffic-pigeon',
    kind: 'news',
    lines: [
      ['skip', "Skip here in the Skycopter with your traffic. Downtown is moving, mostly sideways."],
      ['skip', "There's a stalled city bus in Midtown with a very angry pigeon on the roof. The pier road is clear, the beach road is clear, and somebody has parked a fire engine in a drive-through in Southgate."],
      ['skip', "Officers on the scene tell me he just wanted fries. Back to you, Chet."],
    ],
  },
  {
    id: 'traffic-hill',
    kind: 'news',
    lines: [
      ['skip', "Skip in the Skycopter. Heavy delays in Hillcrest, where a driver has been trying to parallel park for forty minutes. We're all rooting for you, buddy."],
      ['skip', "Down at the docks the cranes are swinging, the containers are stacking, and a forklift is doing a burnout, which I did not know they could do."],
      ['skip', "Avoid the stadium after six. Avoid the stadium before six too. Just avoid the stadium."],
    ],
  },

  // Ads. THE BOWL and STATIC air the ones that name them in `shows`, and their own (shows/bowl.ts, shows/static.ts).
  {
    id: 'ad-pipsqueak',
    kind: 'ad',
    lines: [
      ['announcer', "Tired of being noticed? Introducing the all new Pipsqueak. It's small. It's beige. It's so forgettable, even car thieves walk right past it."],
      ['announcer', "The Pipsqueak. Zero to sixty, eventually. Now with cupholders. Nobody wants one, and that's the point."],
    ],
  },
  {
    id: 'ad-nightjar',
    kind: 'ad',
    lines: [
      ['announcer', "The Nightjar GT. Because life is short, and so is your attention span. Six hundred horsepower. Two seats. One very nervous insurance agent."],
      ['announcer', "The Nightjar GT. The speed of a jet, the trunk of a lunchbox. Financing available for people who make bad decisions quickly."],
    ],
  },
  {
    id: 'ad-guns',
    kind: 'ad',
    lines: [
      ['announcer', "Bang Bang Guns, in Southgate and on the Westside! Home of the friendliest staff in San Azura."],
      ['announcer', "Ask about our family pack. Our layaway plan. Our no questions, seriously, stop asking questions guarantee. Bang Bang Guns. We know a guy. We are the guy."],
    ],
  },
  // Morty Fenwick's campaign, one part a break: from his office, his car, the payphone outside SAPD Central, a cell.
  {
    id: 'ad-lawyer',
    kind: 'ad',
    shows: ['azura', 'bowl'],
    series: 'morty',
    part: 1,
    lines: [
      ['announcer', "Have you been arrested? Have you been arrested more than twice this week?"],
      ['morty', "Hi, I'm Morty Fenwick, attorney at law. Car theft? Hit and run? Accidentally drove onto the pier? Morty's got you."],
      ['announcer', "Morty Fenwick. Technically a lawyer."],
    ],
  },
  {
    id: 'ad-morty-car',
    kind: 'ad',
    shows: ['azura', 'bowl'],
    series: 'morty',
    part: 2,
    lines: [
      ['announcer', "Has your car been impounded? Has it been impounded with you still in it?"],
      ['morty', "Morty Fenwick again, coming to you from my car, which is also my office now, since the landlord changed the locks. Joyriding? Reckless driving? Drove a stolen cab with the meter running? Morty's got you."],
      ['morty', "Consultations in the back seat. Bring snacks."],
      ['announcer', "Morty Fenwick. Technically a lawyer. Technically a car."],
    ],
  },
  {
    id: 'ad-morty-payphone',
    kind: 'ad',
    shows: ['azura', 'bowl'],
    series: 'morty',
    part: 3,
    lines: [
      ['morty', "Hi, it's Morty Fenwick, calling from the payphone outside SAPD Central, to be closer to my clients. Also, they towed my car.", { phone: true }],
      ['morty', "Arrested? Wanted? Wanted and arrested? Just yell my name from the cells. I'm right outside. I can hear you.", { phone: true }],
      ['announcer', "Morty Fenwick. Technically a lawyer. Currently loitering."],
    ],
  },
  {
    id: 'ad-morty-cell',
    kind: 'ad',
    shows: ['azura', 'bowl'],
    series: 'morty',
    part: 4,
    lines: [
      ['announcer', "The following message was recorded at SAPD Central."],
      ['morty', "Hi, Morty Fenwick. Good news. I've never been closer to my clients. Bad news. I'm in the cell next to them.", { phone: true }],
      ['morty', "Turns out you can't live in a car outside a police station for three weeks. Who knew? Me. I should have known. I'm a lawyer.", { phone: true }],
      ['announcer', "Morty Fenwick. Technically a lawyer. Currently a client."],
    ],
  },
  {
    id: 'ad-torque',
    kind: 'ad',
    shows: ['azura', 'bowl', 'static'],
    lines: [
      ['announcer', "Torque energy drink. It tastes like a battery and feels like a car crash. Now in blue flavor. What is blue flavor? Nobody knows."],
      ['announcer', "Torque. Sleep is for people with nothing to do."],
    ],
  },
  {
    id: 'ad-insurance',
    kind: 'ad',
    shows: ['azura', 'static'],
    lines: [
      ['announcer', "Azura Mutual Insurance. Car fire? Covered. Sinkhole? Covered. Car fire in a sinkhole? Let's not get greedy."],
      ['announcer', "Azura Mutual. We're probably there for you."],
    ],
  },
  {
    id: 'ad-hospital',
    kind: 'ad',
    lines: [
      ['dolores', "San Azura General Hospital. Our emergency room is open day and night, and our gift shop is open nine to five, so please get hurt during business hours."],
      ['dolores', "San Azura General. We'll fix you, we'll bill you, we'll see you next week."],
    ],
  },
  {
    id: 'ad-spray',
    kind: 'ad',
    lines: [
      ['announcer', "Spray Shack! Drive in, drive out, different color. No appointments. No paperwork. No memory of you ever being here."],
      ['announcer', "Spray Shack. A fresh coat for a fresh start."],
    ],
  },
  {
    id: 'ad-tacos',
    kind: 'ad',
    shows: ['azura', 'static'],
    lines: [
      ['announcer', "Taco Tornado. Thirty six fillings, one regrettable decision. Try the Inferno Burrito, now served with a waiver."],
      ['announcer', "Taco Tornado. Open late, because you are up late."],
    ],
  },
  {
    id: 'ad-pier',
    kind: 'ad',
    lines: [
      ['ident', "Azura Pier! Ride the Ferris wheel, win a giant stuffed shark, and lose your hat to a seagull."],
      ['ident', "Fun for the whole family, including the seagull."],
    ],
  },
  {
    id: 'ad-hillcrest',
    kind: 'ad',
    shows: ['azura', 'static'],
    lines: [
      ['announcer', "Hillcrest Heights. Luxury living for people who are just a little bit better than you."],
      ['announcer', "Three car garages. Two car families. One very strict homeowners association. Hillcrest Heights. Keep off the grass. We mean it."],
    ],
  },
  {
    id: 'ad-thunderhoof',
    kind: 'ad',
    lines: [
      ['announcer', "The Thunderhoof. It's loud. It's thirsty. It parks across two spaces, and it does not apologize."],
      ['announcer', "The Thunderhoof. For men who need you to know they're coming."],
    ],
  },

  // The fine print, read at one and a half times the speed.
  {
    id: 'ad-pipsqueak-deal',
    kind: 'ad',
    lines: [
      ['announcer', "It's the Pipsqueak Spring Sales Event! Zero down, zero percent, zero people looking at you. Drive home a brand new Pipsqueak today."],
      ['announcer', "The Pipsqueak is not a getaway vehicle. The Pipsqueak will not outrun a cruiser, a bicycle, or a determined toddler. Offer void where people can see you.", { speed: 1.5 }],
    ],
  },
  {
    id: 'ad-unclench',
    kind: 'ad',
    lines: [
      ['announcer', "Do you honk at red lights? Do red lights honk back? Ask your doctor about Unclench, the once a day pill for drivers who are one more merge away from the evening news."],
      ['announcer', "Unclench may cause drowsiness, patience and sudden use of the turn signal. Do not take Unclench with Torque. Tell your doctor if you have been on the news twice in one week.", { speed: 1.5 }],
    ],
  },
  {
    id: 'ad-scratch',
    kind: 'ad',
    lines: [
      ['ident', "Play Lucky Pier, the scratch card from the Azura Lottery! Scratch three Ferris wheels and win a ride on the Ferris wheel. Scratch three sharks and win a giant stuffed shark."],
      ['announcer', "Odds of winning, one in forty million. Odds of losing your hat to a seagull while you scratch, one in three. Prizes are paid at the top of the Ferris wheel, which may stop.", { speed: 1.5 }],
    ],
  },

  // The host reads it himself.
  {
    id: 'ad-torque-chet',
    kind: 'ad',
    lines: [
      ['chet', "Folks, you know I don't do ads. But I have been drinking Torque energy drink every morning this week, and I have not slept since Tuesday."],
      ['chet', "It tastes like a battery, folks. I mean that as a compliment. I licked a battery once when I was a kid, and I've been chasing that feeling ever since."],
      ['chet', "Torque. Ask for the blue one. Nobody knows what blue is."],
    ],
  },

  // Sketches.
  {
    id: 'ad-mutual-claim',
    kind: 'ad',
    lines: [
      ['announcer', "Azura Mutual, claims line, how can I help?"],
      ['jen', "Hi, my boyfriend drove our car into the Marina."],
      ['announcer', "Is the car on fire?"],
      ['jen', "Not yet."],
      ['announcer', "Then you're not covered yet."],
      ['jen', "How would it be on fire? It's underwater."],
      ['announcer', "Ma'am, we're an insurance company. We can't tell you that. Officially. Azura Mutual. We're probably there for you."],
    ],
  },
  {
    id: 'ad-tornado-window',
    kind: 'ad',
    lines: [
      ['doris', "Welcome to Taco Tornado, what can I get you, love?"],
      ['gary', "One Inferno Burrito, please.", { phone: false }],
      ['doris', "Lovely. Would you like the waiver with that?"],
      ['gary', "Is the waiver extra?", { phone: false }],
      ['doris', "The waiver is free, love. The hospital is extra."],
      ['announcer', "Taco Tornado. Thirty six fillings, one regrettable decision. Open late, because you are up late."],
    ],
  },

  // Jobs: Azura Cab's fares, San Azura General's ambulance and Azura Express's runs from First Azura Bank.
  {
    id: 'ad-cab-jobs',
    kind: 'ad',
    lines: [
      ['announcer', "Azura Cab is hiring! Clean driving record? Great. Messy one? We don't check. Find one of our cabs anywhere in San Azura, get in, and start picking up fares."],
      ['announcer', "The faster you drive, the bigger the tip. Azura Cab. However you got the cab, you're one of us now."],
    ],
  },
  {
    id: 'ad-paramedic-jobs',
    kind: 'ad',
    lines: [
      ['dolores', "San Azura General is looking for paramedics. If you can drive fast, stay calm and lift a grown man off the pavement, there is an ambulance waiting outside our doors."],
      ['dolores', "Experience preferred, not required. The keys are in the ambulance. San Azura General. We'll train you on the way."],
    ],
  },
  {
    id: 'ad-courier-jobs',
    kind: 'ad',
    lines: [
      ['ident', "Azura Express needs couriers! Any car, any bike, any time. Pick up your parcels at First Azura Bank, and get them across town before the clock runs out."],
      ['ident', "We don't ask what's in the parcels, and neither should you. Azura Express. It's not a crime if you're on time."],
    ],
  },

  // Station idents, played over the jingle's bells.
  { id: 'ident-cheap', kind: 'ident', lines: [['ident', "Azura Talk, one oh four point five. Talk is cheap. We're cheaper."]] },
  { id: 'ident-voice', kind: 'ident', lines: [['ident', "You're listening to Azura Talk. The voice of San Azura, whether it likes it or not."]] },
  { id: 'ident-facts', kind: 'ident', lines: [['ident', "Azura Talk. All of the opinions. None of the facts."]] },
  { id: 'ident-road', kind: 'ident', lines: [['ident', "Azura Talk, one oh four point five. Eyes on the road, ears on us."]] },
  { id: 'ident-works', kind: 'ident', lines: [['ident', "This is Azura Talk. If you can hear this, your radio works. Congratulations."]] },
];

/**
 * Spoken idents of the music stations, by station name as the radio lists it (src/audio/radio.ts STATIONS): a DJ's
 * voice between songs. A station without an entry has none.
 */
export const STATION_IDENTS: Readonly<Record<string, { voice: string; lines: readonly string[] }>> = {
  'NEON DRIVE 88.7': {
    voice: 'af_aoede',
    lines: [
      "Neon Drive, eighty eight point seven. Windows down, lights on, nowhere to be.",
      "You're cruising with Neon Drive. The city looks better at night.",
      "Neon Drive. Retro sounds for drivers who never grew up.",
    ],
  },
  'BOOM BAP 101.3': {
    voice: 'am_onyx',
    lines: [
      "Boom Bap, one oh one point three. Real beats for real streets.",
      "This is Boom Bap. Turn it up, roll it slow.",
      "Boom Bap, one oh one three. Keeping San Azura nodding since forever.",
    ],
  },
  'PULSE 96.1': {
    voice: 'bf_alice',
    lines: [
      "Pulse, ninety six point one. Four on the floor, all day and all night.",
      "You're locked into Pulse. Don't stop now.",
      "Pulse, ninety six one. The party is wherever you park.",
    ],
  },
  'VELVET 89.9': {
    voice: 'af_nicole',
    lines: ['Velvet, eighty nine point nine. Music to wait to.', 'Relax. Whatever it is, it can wait. This is Velvet.'],
  },
  'DOCKSIDE DUB 92.3': {
    voice: 'bm_george',
    lines: ['Dockside Dub, ninety two point three. Bass from the harbour, all night long.', 'Turn it up and lean back. Dockside Dub.'],
  },
  'COYOTE 97.7': {
    voice: 'am_adam',
    lines: ['Coyote, ninety seven point seven. Outlaw country for the open road.', 'Dust on the boots, gas in the tank. You are on Coyote.'],
  },
  'WIPEOUT 99.5': {
    voice: 'am_puck',
    lines: ['Wipeout, ninety nine point five, live from Ocean Beach. Surf is up.', 'Wax your board and floor it. This is Wipeout.'],
  },
  'BREAKNECK 102.7': {
    voice: 'bf_isabella',
    lines: ['Breakneck, one oh two point seven. Faster than the cops.', 'One hundred and seventy four beats a minute. Breakneck.'],
  },
  'PIXEL 103.9': {
    voice: 'af_sky',
    lines: ['Pixel, one oh three point nine. Insert coin to continue.', 'High score radio. You are tuned to Pixel.'],
  },
};

/** A set of short shouts, each rendered in every voice of its pool; a person keeps one voice. */
export interface BarkSet {
  voices: readonly string[];
  lines: readonly string[];
}

const PEDS = ['am_liam', 'bm_fable', 'am_echo', 'bm_lewis', 'af_jessica', 'af_river', 'af_kore', 'bf_lily'];
const COPS = ['am_michael', 'am_onyx', 'bm_daniel', 'af_aoede'];
const GANG = ['am_echo', 'am_onyx', 'af_alloy'];

export const BARKS: Readonly<Record<BarkKind, BarkSet>> = {
  /** A passer-by the player walks up to. */
  greet: { voices: PEDS, lines: ['Hey there.', 'Nice day, huh?', "How's it going?", 'Morning.', 'Watch your step.', 'Nice jacket.', 'You lost?', "Don't look at me."] },
  /** Punched or shot and still standing. */
  hurt: { voices: PEDS, lines: ["Ow! What's your problem?", 'Back off, man!', 'Are you crazy?', 'That hurt!', 'Leave me alone!', 'Somebody help me!'] },
  /** Pulled out of their own car. */
  jacked: { voices: PEDS, lines: ["Hey! That's my car!", 'Not again!', 'Come on, I just washed it!', 'Somebody stop him!', 'He stole my car!'] },
  /** Running from gunfire or fire. */
  panic: { voices: PEDS, lines: ['Help!', "Run! He's got a gun!", 'Call the cops!', 'Oh my god!', 'Get down!', 'Somebody do something!'] },
  /** The driver of a car the player rams. */
  rammed: { voices: PEDS, lines: ['Learn to drive!', 'Hey! Watch it!', 'Are you blind?', 'My insurance!', 'Unbelievable!'] },
  /** A witness on the phone to the police. */
  witness: { voices: PEDS, lines: ["Police? There's a maniac out here!", 'Hello? I want to report a crime. A big one.', 'You need to get down here, right now!', "He's still here! Hurry!"] },
  /** Officers on foot, close to a wanted player. */
  freeze: { voices: COPS, lines: ['Freeze! Police!', 'Stop right there!', "Police! Don't move!", 'Hands where I can see them!', 'On the ground, now!'] },
  /** Officers under fire. */
  shots: { voices: COPS, lines: ['Shots fired! Shots fired!', "He's armed!", 'Take cover!', 'Drop the weapon!'] },
  /** An officer killed nearby. */
  officerDown: { voices: COPS, lines: ['Officer down!', 'We need backup!', 'Man down! We need help here!'] },
  /** The loudspeaker of a cruiser chasing the player's car. */
  pullOver: { voices: COPS, lines: ['Pull over! Now!', 'Stop the vehicle!', 'Driver, pull over to the side of the road!', 'This is the police! Stop your car!'] },
  /** The arrest. */
  arrest: { voices: COPS, lines: ["You're under arrest.", 'Hands behind your back.', 'You have the right to remain silent. Use it.'] },
  /** Gang members starting a fight on their turf. */
  turf: { voices: GANG, lines: ['This is our turf!', 'Wrong neighborhood!', 'You picked the wrong street!', 'Get him!'] },
};
