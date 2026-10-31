// The Moonbeam Drive-In (world/country/places.ts): tonight's bill runs on the game's clock alone, so a multiplayer
// client works out the same reel from its mirrored hours, as it does AzuraLink's train from sim time. reelAt says what
// is on the screen (render/country/driveIn.ts draws it, the lines burned in); showtime when the lot fills (sim/traffic's
// parked cars). A player's horn in the lot while a film runs has the cars round him flash their lights at him and
// shush him (driveInShush), at most once every SHUSH_GAP s.

import { rectContains } from '../world/layout';
import type { StaticWorld } from '../world/staticWorld';
import type { Sim } from './sim';
import { registerSystem } from './systems';

export type SceneSet = 'title' | 'field' | 'lab' | 'city' | 'farmhouse' | 'tower' | 'end' | 'hotdog' | 'marquee';

/** A shot of a film or a card: its set, how long it runs (game minutes), its big words and the line burned in under it. */
export interface Scene {
  set: SceneSet;
  minutes: number;
  title?: readonly [string, string];
  line?: string;
}

export type ReelId = 'corn' | 'scarecrow' | 'intermission' | 'preshow';

export const FILMS: Readonly<Record<ReelId, readonly Scene[]>> = {
  corn: [
    { set: 'title', minutes: 6, title: ['THE CORN THAT ATE SAN AZURA', 'IN TERRIFYING CORN-O-SCOPE'] },
    { set: 'field', minutes: 8, line: 'Hollister Bottoms. Population: us, and forty acres of corn.' },
    { set: 'lab', minutes: 9, line: "Doctor, the corn... it's moving!" },
    { set: 'lab', minutes: 9, line: "Corn doesn't move, Linda. Corn just grows. Angrily." },
    { set: 'field', minutes: 9, line: 'Did you hear that? It sounded like... popping.' },
    { set: 'city', minutes: 9, line: "It's heading for the city! Nobody's ever stopped a cob that size!" },
    { set: 'city', minutes: 9, line: 'Call the army! Call the navy! Call the butter council!' },
    { set: 'tower', minutes: 9, line: 'We have to lure it out over the sound.' },
    { set: 'field', minutes: 9, line: 'What do you want from us?! ...MAIZE.' },
    { set: 'lab', minutes: 7, line: 'We fought nature, Linda. And nature brought salt.' },
    { set: 'end', minutes: 6, title: ['THE END?', 'NO. THE SEQUEL STARTS AT 9:15.'] },
  ],
  scarecrow: [
    { set: 'title', minutes: 6, title: ['ATTACK OF THE 50-FOOT SCARECROW', "HE'S OUTSTANDING IN HIS FIELD."] },
    { set: 'farmhouse', minutes: 9, line: "Pa, the scarecrow's gone from the north field." },
    { set: 'farmhouse', minutes: 9, line: "Then who's been scaring the crows?" },
    { set: 'field', minutes: 9, line: 'Nobody, Ma. The crows are doing whatever they want now.' },
    { set: 'city', minutes: 9, line: "He's fifty feet of straw and bad intentions!" },
    { set: 'city', minutes: 9, line: "Somebody tell him the corn's the other way!" },
    { set: 'tower', minutes: 9, line: "He's not attacking us, Sheriff. He's guarding us. From birds." },
    { set: 'field', minutes: 9, line: 'Then we give him a field big enough to stand in.' },
    { set: 'farmhouse', minutes: 9, line: "Goodnight, big fella. Scare 'em good." },
    { set: 'end', minutes: 12, title: ['THE END', 'NO CROWS WERE HARMED. SEVERAL WERE INCONVENIENCED.'] },
  ],
  intermission: [{ set: 'hotdog', minutes: 15, title: ['INTERMISSION', 'HOT DOGS. COLD SODA. LUKEWARM ROMANCE.'] }],
  preshow: [{ set: 'marquee', minutes: 30, title: ['MOONBEAM DRIVE-IN', 'TONIGHT 7:30 THE CORN THAT ATE SAN AZURA · 9:15 ATTACK OF THE 50-FOOT SCARECROW'] }],
};

/** Tonight's bill: when each reel starts, in hours (past midnight they run on from 24). Each runs its scenes' length. */
export const BILL: ReadonlyArray<{ at: number; reel: ReelId }> = [
  { at: 19, reel: 'preshow' },
  { at: 19.5, reel: 'corn' },
  { at: 21, reel: 'intermission' },
  { at: 21.25, reel: 'scarecrow' },
  { at: 22.75, reel: 'intermission' },
  { at: 23, reel: 'corn' },
];

/** The lot fills for the show from LOT_OPEN to LOT_CLOSE (01:00). */
export const LOT_OPEN = 19;
export const LOT_CLOSE = 25;
/** A horn shushed sets off no other for this long (s). */
export const SHUSH_GAP = 4;

export interface Reel {
  reel: ReelId;
  /** The scene's index in FILMS[reel], and the game minutes since it began. */
  scene: number;
  t: number;
}

/** The hours on the bill's clock: those before noon run on from 24. */
function billHours(hours: number): number {
  return hours < 12 ? hours + 24 : hours;
}

/** What is on the screen at `hours` (the game clock's), or null while the screen is dark. */
export function reelAt(hours: number): Reel | null {
  const h = billHours(hours);
  for (let k = BILL.length - 1; k >= 0; k--) {
    const b = BILL[k]!;
    if (h < b.at) continue;
    let m = (h - b.at) * 60;
    const scenes = FILMS[b.reel];
    for (let i = 0; i < scenes.length; i++) {
      if (m < scenes[i]!.minutes) return { reel: b.reel, scene: i, t: m };
      m -= scenes[i]!.minutes;
    }
    return null;
  }
  return null;
}

/** Whether the lot is open, its bays filling for the show. */
export function showtime(hours: number): boolean {
  const h = billHours(hours);
  return h >= LOT_OPEN && h < LOT_CLOSE;
}

/** Whether a horn at (x, z) is shushed: in the lot while a film runs (not the preshow or the intermission). */
export function shushes(world: StaticWorld, hours: number, x: number, z: number): boolean {
  const r = reelAt(hours);
  return !!r && (r.reel === 'corn' || r.reel === 'scarecrow') && rectContains(world.layout.country.places.driveIn.lot, x, z);
}

const listening = new WeakMap<Sim, { next: number }>();

registerSystem({
  id: 'driveIn',
  slot: 'afterPlayers',
  update(sim) {
    if (listening.has(sim)) return;
    const s = { next: -Infinity };
    listening.set(sim, s);
    sim.events.on('horn', (e) => {
      const v = e.vehicle;
      if (sim.time < s.next || !sim.slotOf(v.driver) || !shushes(sim.world, sim.clock.hours, v.pos.x, v.pos.z)) return;
      s.next = sim.time + SHUSH_GAP;
      sim.events.emit('driveInShush', { x: v.pos.x, z: v.pos.z });
    });
  },
});
