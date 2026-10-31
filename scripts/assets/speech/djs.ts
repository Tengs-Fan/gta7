// The music stations' DJs: a name, a Kokoro voice (a blend 'a,b' where a voice alone is already somebody else) and what
// they say over a song's intro, which the DJ programme (src/audio/djProgramme.ts) picks: idents, banter, lines for the
// night, the rain, a chase and a chase got away from, and the announce and back-announce of each of the station's hits
// (src/audio/stations/playlists.ts). Every line is original.
//
// A link plays only if it fits the 4-bar intro, less 0.6 s, at the song's tempo: about 4.5 s on BREAKNECK, 5 s on
// WIPEOUT and PIXEL, 6 s on VELVET and PULSE, 6.5 s on COYOTE, 7.5 s on NEON DRIVE, 9 s on BOOM BAP and 10 s on DOCKSIDE
// DUB, a little less in a chase (tests/unit/radio_dj.test.ts holds every clip to its station's fastest intro).

import type { LinkKind } from '../../../src/sim/speech';

/** A voice and its words: a link with a second voice is a few of them, rendered as one clip. */
export type Take = readonly [voice: string, text: string];
/** A link: the DJ's line, or takes in two voices. */
export type Line = string | readonly Take[];

export interface Dj {
  dj: string;
  voice: string;
  /** Kokoro's speed for everything the DJ says (default 1). */
  speed?: number;
  /** The lines of each kind; 'ident' fills the speech index's idents, the rest its dj links. */
  links: Partial<Record<Exclude<LinkKind, 'front' | 'back'>, readonly Line[]>>;
  /** A hit's announce and back-announce: '{artist}' and '{title}' are filled in, the station's hit i taking frame i % n. */
  front: readonly string[];
  back: readonly string[];
}

/** Any DJ, in a chase. */
const SIRENS = "I can hear sirens from the booth. This one's for whoever they're chasing.";

const KIKI = 'bf_alice';
const TOM_TOM = 'am_liam,am_echo';

/** By station name as the radio lists it (src/audio/radio.ts STATIONS). */
export const DJS: Readonly<Record<string, Dj>> = {
  'NEON DRIVE 88.7': {
    dj: 'Lazer Lacey',
    voice: 'af_aoede',
    links: {
      ident: [
        'Neon Drive, eighty eight point seven. Windows down, lights on, nowhere to be.',
        "You're cruising with Neon Drive. The city looks better at night.",
        'Neon Drive. Retro sounds for drivers who never grew up.',
      ],
      banter: [
        "This is Lazer Lacey. If your dashboard glows purple, you're doing it right.",
        'Somebody asked if the eighties are coming back. Honey, on this station they never left.',
        'Fun fact. Every song on this station was recorded in a parked car, engine running.',
        'I drove past the pier tonight. Pink lights, empty boardwalk, one sad seagull. Perfect.',
      ],
      night: ["It's late, San Azura. The neon is humming, and so am I.", 'Night shift, night owls, night drivers. This hour belongs to you.'],
      rain: ['Rain on the windshield, neon in the puddles. Honestly? This is the look.', "It's raining, San Azura. Wipers on the beat, please."],
      chase: [SIRENS, 'Somebody out there is in a hurry. Neon Drive is your getaway soundtrack.'],
      gotAway: ['Sirens fading in the rear-view. Neon Drive. Smooth.', 'And just like that, the helicopter goes home. Easy, baby.'],
    },
    front: ["Here's {artist}, with {title}.", 'Windows down for {artist}. This is {title}.', 'Neon Drive, after dark. {artist}, {title}.'],
    back: ['That was {title}, by {artist}. Synthesizers never die.', '{artist}, with {title}. Still the best thing about the eighties.'],
  },
  'VELVET 89.9': {
    dj: 'Simone Satin',
    voice: 'af_nicole',
    links: {
      ident: ['Velvet, eighty nine point nine. Music to wait to.', 'Relax. Whatever it is, it can wait. This is Velvet.'],
      banter: [
        "You're on hold with life. Your call is important to us.",
        'Relax. Your place in the queue has been saved.',
        'This is Simone Satin. Breathe in. Hold. Keep holding.',
        'Velvet. The music they play while you wait for a table.',
      ],
      night: ['It is late. Even the waiting room is closed.', 'Late night on Velvet. The lobby is empty, the carpet is soft.'],
      rain: ['Rain outside. Velvet inside. Stay a while.', 'Listen to that rain. Nobody is going anywhere.'],
      chase: [SIRENS, "Sirens? Don't worry. They're on hold too."],
      gotAway: ['The sirens have stopped. Thank you for your patience.', 'Lost them? Lovely. Please continue to hold.'],
    },
    front: ['{artist}. {title}.', 'Now holding: {title}, by {artist}.', 'Please enjoy {artist}, with {title}.'],
    back: ['That was {title}, by {artist}.', '{artist}, with {title}. Lovely.'],
  },
  'DOCKSIDE DUB 92.3': {
    dj: 'Captain Reverb',
    voice: 'bm_george,bm_daniel',
    links: {
      ident: ['Dockside Dub, ninety two point three. Bass from the harbour, all night long.', 'Turn it up and lean back. Dockside Dub.'],
      banter: [
        'Captain Reverb here, live from the docks. The docks. The docks.',
        'Every container in this harbour holds one thing. Bass. And maybe some trainers.',
        'A seagull stole my sandwich today. I have forgiven him. That is dub.',
        'Customs asked what I was bringing in. I said, echo. They said, echo? I said, exactly.',
      ],
      night: ['Night tide coming in, slow and heavy. Just like this record.', 'The cranes are sleeping. The bass is not.'],
      rain: ["Rain on the harbour. The ships don't mind, and neither should you.", 'Storm clouds over the docks. Lean back. The bass is waterproof.'],
      chase: [SIRENS, "Police boats in the harbour tonight. Slow down, my friend. Or don't."],
      gotAway: ['The sirens fade out across the water, like a good echo.', 'You lost them in the fog. Captain Reverb salutes you.'],
    },
    front: ['Captain Reverb at the controls. Here comes {artist}, with {title}.', 'Lower the anchor. This is {artist}. {title}.'],
    back: ['That was {title}, by {artist}. Heavy, like cargo.', '{artist} there, with {title}. Mind the forklifts.'],
  },
  'PULSE 96.1': {
    dj: 'Kiki',
    voice: KIKI,
    speed: 1.05,
    links: {
      ident: ['Pulse, ninety six point one. Four on the floor, all day and all night.', "You're locked into Pulse. Don't stop now.", 'Pulse, ninety six one. The party is wherever you park.'],
      banter: [
        [
          [KIKI, 'Tom-Tom, what time is it?'],
          [TOM_TOM, 'Four on the floor, Kiki.'],
        ],
        [
          [KIKI, 'Tom-Tom, how was the club?'],
          [TOM_TOM, 'Long line. Short night. Lost a shoe.'],
        ],
        "Kiki on Pulse. If your car isn't bouncing, turn it up.",
        'Pulse, ninety six one. The coat check never closes.',
      ],
      night: [
        "It's late, it's Pulse, and the club does not close.",
        [
          [KIKI, 'Tom-Tom, is it bedtime?'],
          [TOM_TOM, 'Not on Pulse.'],
        ],
      ],
      rain: ['Rain? Brilliant. Free foam party.', 'Wet roads, warm bass. Keep it moving.'],
      chase: [
        SIRENS,
        [
          [TOM_TOM, 'Kiki, those sirens are on the beat.'],
          [KIKI, 'Then we keep dancing.'],
        ],
      ],
      gotAway: ['Sirens gone. The party survives.', 'You lost them! Pulse loves a happy ending.'],
    },
    front: ["Kiki on Pulse! Here's {artist}, {title}!", 'Hands up for {artist}. {title}!', 'This is {artist}. {title}!'],
    back: ['That was {title}, by {artist}.', '{artist}, {title}. Still sweating.'],
  },
  'COYOTE 97.7': {
    dj: 'Earl Tumbleweed',
    voice: 'am_adam',
    speed: 0.92,
    links: {
      ident: ['Coyote, ninety seven point seven. Outlaw country for the open road.', 'Dust on the boots, gas in the tank. You are on Coyote.'],
      banter: [
        'That was a song about a man who lost his truck, his dog and his wife. In that order.',
        'Earl Tumbleweed here. My doctor said cut back on whiskey. So I cut back to whiskey.',
        "If you're driving a pickup, wave. If you're not, we forgive you. Mostly.",
        "Coyote. Three chords, two lanes, and one long night.",
      ],
      night: ['Late night on Coyote. The stars are out, and so is my back.', "Moon's up, roads are empty. Just you, me and a sad song."],
      rain: ['Rain on the windshield. Good for the crops. Bad for the hair.', 'Storm rolling in. Pull over, or turn it up.'],
      chase: [SIRENS, 'Sounds like a posse out there. Ride, partner. Ride.'],
      gotAway: ["Lost the law, did ya? Coyote don't judge.", "Sirens gone quiet. Out here, that's a good day."],
    },
    front: ["Here's {artist}. {title}.", 'This here is {artist}, with {title}.'],
    back: ['That was {title}, by {artist}. Lord have mercy.', '{title}. {artist}. Somebody check on them.'],
  },
  'WIPEOUT 99.5': {
    dj: 'Tad Tubular',
    voice: 'am_puck,am_liam',
    speed: 1.08,
    links: {
      ident: ['Wipeout, ninety nine point five, live from Ocean Beach. Surf is up.', 'Wax your board and floor it. This is Wipeout.'],
      banter: [
        'Tad Tubular on Wipeout. Surf report: wet.',
        'Lost my board again. If you find it, it is yours now.',
        'Ocean Beach, dude. Sand in the car is a lifestyle.',
        "Fun fact. Sharks can't surf. Respect the sharks anyway.",
      ],
      night: ["Night surf, dude. Can't see the waves. Can't see the sharks.", "Moon's out, tide is high, and so is the reverb."],
      rain: ["It's raining, dude. We were getting wet anyway.", 'Storm swell! Bad for driving, gnarly for surfing.'],
      chase: [SIRENS, 'Cops on your tail? Ride that wave, bro.'],
      gotAway: ['Lost the cops. Total wipeout. For them.', 'Sirens gone. Hang loose, legend.'],
    },
    front: ['Wipeout! This is {artist}, with {title}!', 'Paddle out for {artist}. {title}!'],
    back: ['That was {title}, by {artist}. Gnarly.', '{artist}, {title}. Totally tubular.'],
  },
  'BOOM BAP 101.3': {
    dj: 'Vinyl Vic',
    voice: 'am_onyx,am_michael',
    links: {
      ident: ['Boom Bap, one oh one point three. Real beats for real streets.', 'This is Boom Bap. Turn it up, roll it slow.', 'Boom Bap, one oh one three. Keeping San Azura nodding since forever.'],
      banter: [
        "Vinyl Vic here. If your neck ain't nodding, check your pulse.",
        "Back in my day we sampled our parents' records. Then they grounded us.",
        'Shout out to everybody stuck on the ring road. This one is your soundtrack.',
        'Boom Bap. No gimmicks, just a drum break and a bad attitude.',
      ],
      night: ['Late night on Boom Bap. Streetlights on, volume up, neighbors asleep. Not for long.', 'Night time is the right time for a dusty drum break.'],
      rain: ['Rain in the city. Windows up, bass up, worries down.', 'Storm out there. Stay dry and keep nodding.'],
      chase: [SIRENS, "Hear that? That's not a sample. Those are real sirens."],
      gotAway: ['Sirens fading. Another one gets away. Respect.', "Lost them? Smooth, like a needle on wax."],
    },
    front: ["Vinyl Vic on Boom Bap. Here's {artist} with {title}.", 'Straight off the shelf, {artist}. {title}. Nod your head.'],
    back: ['That was {title}, by {artist}. No skips.', '{artist}, with {title}. Put that one back in the crate.'],
  },
  'BREAKNECK 102.7': {
    dj: 'MC Velocity',
    voice: 'bf_isabella',
    speed: 1.12,
    links: {
      ident: ['Breakneck, one oh two point seven. Faster than the cops.', 'One hundred and seventy four beats a minute. Breakneck.'],
      banter: [
        'One seventy four beats a minute. Faster than a Nightjar on the ring road.',
        'MC Velocity. I talk fast because the intros are short.',
        "If you can read your speedometer, you're too slow.",
        'Breakneck. Brakes optional. Bass is not.',
      ],
      night: ['Late night, empty roads. You know what to do.', 'Night mode. Lights low, bass high.'],
      rain: ['Wet roads at one seventy four? Brave.', 'Rain on the tarmac. Grip is a state of mind.'],
      chase: [SIRENS, "Hear those sirens? They're slower than the snare."],
      gotAway: ['Gone. Faster than the cops. Told you.', 'Sirens? Lost them three bars ago.'],
    },
    front: ['Breakneck! {artist}, {title}!', 'Velocity on the decks. {artist}. {title}!'],
    back: ['{title}, {artist}. Keep up.', 'That was {title}, by {artist}. Rewind? No time.'],
  },
  'PIXEL 103.9': {
    dj: 'Player Two',
    voice: 'af_sky,af_nova',
    speed: 1.05,
    links: {
      ident: ['Pixel, one oh three point nine. Insert coin to continue.', 'High score radio. You are tuned to Pixel.'],
      banter: [
        'Player Two, on Pixel. Press start to continue.',
        'Blowing on the cartridge fixes everything. Even feelings.',
        'Pixel, one oh three nine. Lag free since never.',
        'Achievement unlocked: listened to the radio.',
      ],
      night: ["It's late. One more level, then bed. Probably.", 'Night mode on. Brightness down, volume up.'],
      rain: ["It's raining. Actual pixels of water.", 'Rain level unlocked. Watch out for slippery tiles.'],
      chase: [SIRENS, 'Boss fight! Stars up, no continues.'],
      gotAway: ['You lost them! Extra life!', 'Stars cleared. Game saved. Nice run.'],
    },
    front: ['Next level: {artist}, with {title}!', 'Insert coin for {artist}. {title}.'],
    back: ['That was {title}, by {artist}. High score.', '{artist}, {title}. Progress saved.'],
  },
};
