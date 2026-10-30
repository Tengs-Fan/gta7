// What the music stations play: six recurring hits per station by fictional artists, and endless deep cuts in between
// with titles from each genre's word tables. A hit is composed from its own seed, so it is the same song every time it
// comes round (the seeds were picked by computing: songs that differ in progressions, pattern, key and tempo). The
// speech build (scripts/assets/speech/build.ts) reads HITS for the DJs' announces. Every name is original.

import { Rng } from '../../core/rng';
import type { Song, Style } from './style';

export interface Track {
  artist: string;
  title: string;
  /** Composes the song (hitSong). */
  seed: number;
}

/** Each music station's hits, by station name as the radio lists it (radio.ts STATIONS). */
export const HITS: Readonly<Record<string, readonly Track[]>> = {
  'NEON DRIVE 88.7': [
    { artist: 'Midnight Refund', title: 'Tax Season Forever', seed: 1000 },
    { artist: 'Kelly Neon', title: 'Mall Rats in Love', seed: 1006 },
    { artist: 'The Laser Tag Champions', title: 'Arcade Carpet Burn', seed: 1124 },
    { artist: 'Vapor Lease', title: 'Lease to Own My Heart', seed: 1002 },
    { artist: 'Sunset Grid', title: 'Hologram Prom Date', seed: 1192 },
    { artist: 'Doctor Overdrive', title: 'Night Shift at the Video Store', seed: 1318 },
  ],
  'VELVET 89.9': [
    { artist: 'The Hold Music Quartet', title: 'Your Call Is Important to Us', seed: 2000 },
    { artist: 'Lorna Velour', title: 'Martini at the Dentist', seed: 2012 },
    { artist: 'The Escalator Strings', title: 'Please Take a Number', seed: 2037 },
    { artist: 'Bossa Nova Scotia', title: 'Waiting Room Samba', seed: 2019 },
    { artist: 'Sergio Beige', title: 'Complimentary Breadsticks', seed: 2326 },
    { artist: 'The Mezzanine Orchestra', title: 'Going Down, Lobby Level', seed: 2373 },
  ],
  'DOCKSIDE DUB 92.3': [
    { artist: 'King Forklift', title: 'Container Ship Version', seed: 3000 },
    { artist: 'Dread Reckoning', title: 'Low Tide Dub', seed: 3027 },
    { artist: 'The Bilge Pumps', title: 'Customs Inspection Skank', seed: 3281 },
    { artist: 'Sister Barnacle', title: 'Foghorn Version', seed: 3111 },
    { artist: 'Prince Tugboat', title: 'Heavy Cargo in Dub', seed: 3312 },
    { artist: 'Roots Wharf Collective', title: 'Bonded Warehouse Rock', seed: 3223 },
  ],
  'PULSE 96.1': [
    { artist: 'DJ Open Late', title: 'Four on the Floor Plan', seed: 4000 },
    { artist: 'Deep Fryer', title: "Shake It Till It's Crispy", seed: 4002 },
    { artist: 'Lady Strobe', title: 'Glow Stick Emergency', seed: 4378 },
    { artist: 'The Membership Card', title: 'The Guest List Is Longer', seed: 4270 },
    { artist: 'Basement Lease', title: 'Thermostat Jack', seed: 4396 },
    { artist: 'Funky Accountant', title: 'Balance the Books', seed: 4237 },
  ],
  'COYOTE 97.7': [
    { artist: 'Dusty Haybale', title: 'Tequila Took the Dog', seed: 5000 },
    { artist: 'Darla Mae Rattler', title: 'Dirt Road Restraining Order', seed: 5044 },
    { artist: 'The Bootcut Brothers', title: 'Ten Gallon Headache', seed: 5369 },
    { artist: 'Clem Dooley', title: 'Mama Sold the Jukebox', seed: 5217 },
    { artist: 'Rhonda Spurs', title: 'Whiskey Is My Accountant', seed: 5385 },
    { artist: 'Tex Lariat', title: 'Hot Sauce and Heartache', seed: 5074 },
  ],
  'WIPEOUT 99.5': [
    { artist: 'The Riptide Rejects', title: 'Gull Bay Wipeout', seed: 6000 },
    { artist: 'The Shoobies', title: 'Sand in the Sandwich', seed: 6035 },
    { artist: 'Sharky and the Fins', title: 'Lifeguard on Strike', seed: 6213 },
    { artist: 'The Undertow Trio', title: 'Sunburn Stomp', seed: 6078 },
    { artist: 'The Spring Tanks', title: 'Wetsuit Twist', seed: 6171 },
    { artist: 'Johnny Kook', title: 'Board Meeting', seed: 6183 },
  ],
  'BOOM BAP 101.3': [
    { artist: 'MC Parking Ticket', title: 'Double Parked', seed: 7000 },
    { artist: 'Lil Overdraft', title: 'Insufficient Funds', seed: 7005 },
    { artist: 'Tha Library Card', title: 'Late Fees', seed: 7046 },
    { artist: 'Rhyme Inspector', title: 'Noise Complaint', seed: 7053 },
    { artist: 'Kid Laundromat', title: 'Spin Cycle', seed: 7166 },
    { artist: 'The Crosswalk Crew', title: 'Jaywalk With Me', seed: 7035 },
  ],
  'BREAKNECK 102.7': [
    { artist: 'Amen Break Room', title: 'Pursuit Mode', seed: 8000 },
    { artist: 'Sub Pressure', title: 'Rush Hour Rinse Out', seed: 8009 },
    { artist: 'Jungle Gym', title: 'Recess Is Over', seed: 8046 },
    { artist: 'The Getaway Drivers', title: 'Dashcam Footage', seed: 8338 },
    { artist: 'Breakbeat Bakery', title: 'Hot Cross Breaks', seed: 8359 },
    { artist: 'Toll Booth Massive', title: 'Two Step Verification', seed: 8375 },
  ],
  'PIXEL 103.9': [
    { artist: 'Bitcrush Bunny', title: 'Continue? Nine. Eight.', seed: 9000 },
    { artist: '8-Bit Landlord', title: 'Insert Rent to Continue', seed: 9001 },
    { artist: 'The Save Points', title: 'Do Not Turn Off the Power', seed: 9043 },
    { artist: 'Wizard of Lag', title: 'Kill Screen Lullaby', seed: 9006 },
    { artist: 'Sprite Flicker', title: 'Lag Is My Love Language', seed: 9030 },
    { artist: 'Cartridge Blowers', title: 'Press Start to Panic', seed: 9122 },
  ],
};

/**
 * A hit's song, the same every time: composed from its seed, at a tempo drawn from a second stream of it (so the song
 * is exactly `style.song(new Rng(seed), bpm)`, the one tests/unit/radio_stations.test.ts checks for that seed).
 */
export function hitSong(style: Style, seed: number): Song {
  return style.song(new Rng(seed), new Rng(seed ^ 0x5bd1e995).range(style.bpm[0], style.bpm[1]));
}

/** A genre's deep cuts: an artist of two parts and a title of a part from each column ('' leaves a column out). */
interface Cuts {
  artist: readonly [readonly string[], readonly string[]];
  title: readonly (readonly string[])[];
}

const CUTS: Readonly<Record<string, Cuts>> = {
  'NEON DRIVE 88.7': {
    artist: [
      ['Kid', 'Lady', 'Johnny', 'Turbo', 'Sister'],
      ['Vector', 'Hologram', 'Afterglow', 'Mixtape', 'Moonroof'],
    ],
    title: [
      ['Neon', 'Chrome', 'Laser', 'Midnight', 'Rental Car', 'Pastel'],
      ['Highway', 'Heartbreak', 'Mall Walk', 'Arcade', 'Car Phone', 'Shoulder Pad'],
      ['Forever', 'Protocol', 'Overdrive', 'Romance', 'Warranty', 'at Dawn'],
    ],
  },
  'VELVET 89.9': {
    artist: [
      ['Sergio', 'Lorna', 'Monty', 'Bunny', 'Claude'],
      ['Mellow', 'Escalator', 'Lobby', 'Carpet', 'Fondue'],
    ],
    title: [
      ['Please', 'Gently', 'Politely', 'Quietly', 'Patiently'],
      ['Hold', 'Wait', 'Take a Number', 'Remain Seated', 'Hum Along'],
      ['for an Agent', 'in the Lobby', 'Until Called', 'by the Fountain', 'Forever'],
    ],
  },
  'DOCKSIDE DUB 92.3': {
    artist: [
      ['Lord', 'Duke', 'Sister', 'Bongo', 'Dread'],
      ['Ballast', 'Bollard', 'Pallet', 'Gantry', 'Mooring'],
    ],
    title: [
      ['Heavy', 'Rusty', 'Midnight', 'Bonded', 'Low Tide'],
      ['Cargo', 'Crane', 'Customs', 'Anchor', 'Harbour'],
      ['Version', 'in Dub', 'Dubwise', 'Skank', 'Rockers'],
    ],
  },
  'PULSE 96.1': {
    artist: [
      ['DJ', 'Lady', 'Deep', 'MC', 'Professor'],
      ['Coat Check', 'Strobe', 'Thermostat', 'Smoke Machine', 'Wristband'],
    ],
    title: [
      ['Shake Your', 'Lose Your', 'Feel the', 'Find Your', 'Check Your'],
      ['Elbows', 'Thermostat', 'Coat Check', 'Lease', 'Tax Return'],
      ['', '(Club Mix)', '(Dub Mix)', 'Tonight', 'Till Six', '(Extended)'],
    ],
  },
  'COYOTE 97.7': {
    artist: [
      ['Cletus', 'Darla', 'Buck', 'Tammy Jo', 'Wade'],
      ['Tailgate', 'Haystack', 'Muffler', 'Fencepost', 'Cornbread'],
    ],
    title: [
      ['My', 'Your', 'That'],
      ['Truck', 'Dog', 'Ex-Wife', 'Trailer', 'Boots'],
      ['Done Left', 'Ran Off With', 'Got Towed By', 'Outran'],
      ['Me', 'the Mailman', 'the Bank', 'the Sheriff'],
    ],
  },
  'WIPEOUT 99.5': {
    artist: [
      ['The Wax', 'The Shark', 'The Sand', 'The Fin', 'The Gremmie'],
      ['Kings', 'Bandits', 'Tones', 'Monsters', 'Rejects'],
    ],
    title: [
      ['Big Wave', 'Sunburn', 'Low Tide', 'Boardwalk', 'Shark Bait'],
      ['Stomp', 'Twist', 'Shuffle', 'Panic', 'Hop'],
      ['', 'at Dawn', 'Part Two', 'Again', 'Tonight'],
    ],
  },
  'BOOM BAP 101.3': {
    artist: [
      ['MC', 'Lil', 'Big', 'DJ', 'Professor'],
      ['Late Fee', 'Bodega', 'Coupon', 'Bus Pass', 'Leftovers'],
    ],
    title: [
      ['Back to', 'Live From', "Rollin' Through", 'Lost in', 'Stuck in'],
      ['the Laundromat', 'the Bodega', 'Traffic Court', 'the Library', 'Aisle Five'],
      ['', '(Remix)', 'Part Two', '(Clean)', '(Edit)'],
    ],
  },
  'BREAKNECK 102.7': {
    artist: [
      ['Sub', 'Rude', 'Night', 'Static', 'Rapid'],
      ['Pressure', 'Transit', 'Bus', 'Shift', 'Junction'],
    ],
    title: [
      ['Rush Hour', 'Red Light', 'Wrong Way', 'Toll Booth', 'Ring Road'],
      ['Rinse Out', 'Roller', 'Pursuit', 'Getaway', 'Pile Up'],
      ['', '(VIP)', '(Dub)', 'Part Two', '(Rewind)'],
    ],
  },
  'PIXEL 103.9': {
    artist: [
      ['Bit', 'Lag', 'Turbo', 'Sprite', 'Glitch'],
      ['Goblin', 'Lizard', 'Knight', 'Cartridge', 'Joystick'],
    ],
    title: [
      ['World', 'Level', 'Stage', 'Zone', 'Dungeon'],
      ['1-1', '2-4', '8-3', '99', 'Zero'],
      ['', '(Boss Theme)', '(Game Over)', '(Hard Mode)', '(Secret)'],
    ],
  },
};

/** A deep cut's artist and title, from its station's word tables. */
export function deepCut(station: string, r: Rng): { artist: string; title: string } {
  const c = CUTS[station]!;
  return {
    artist: `${r.pick(c.artist[0])} ${r.pick(c.artist[1])}`,
    title: c.title
      .map((col) => r.pick(col))
      .filter(Boolean)
      .join(' '),
  };
}
