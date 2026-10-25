// Who wears what: the character models (src/assets/models/characters), how each one's materials take a character's
// appearance colours, the accessories added to it, and the pure assignment of a look and a body type to a character.
//
// The assignment depends only on the character's id, role, gang and appearance (never the sim's RNG), so a character
// keeps his look across frames, saves and multiplayer clients; players are dressed from their appearance alone.
import type { Appearance, CharacterRole } from '../../sim/entities';
import type { GangId } from '../../world/layout';
import { PLAYER_COLORS } from '../../sim/appearance';
import { idSeed } from './rig';

export type SlotName = 'fixed' | 'skin' | 'hair' | 'shirt' | 'pants' | 'hat' | 'shoes' | 'accent';
export type AccessoryId =
  | 'cap' | 'beanie' | 'policeCap' | 'glasses' | 'sunglasses' | 'dutyBelt' | 'radio' | 'badge' | 'backpack' | 'shoulderBag'
  | 'bandana' | 'chain' | 'watch' | 'headset';
export type LookGroup = 'civilian' | 'cop' | 'swat' | 'tiburones' | 'halcones' | 'player';

export interface Look {
  id: string;
  /** Manifest id of the model. */
  model: string;
  group: LookGroup;
  /** Material name -> colour slot; materials not listed keep their own colour. */
  slots: Readonly<Record<string, SlotName>>;
  /** Primitives (by material name) left out, e.g. a hard hat under a police cap. */
  drop?: readonly string[];
  accessories: readonly AccessoryId[];
  female: boolean;
}

// Materials of the Quaternius models, by role in the outfit.
const SKIN: Record<string, SlotName> = { Skin: 'skin', Skin_Darker: 'skin' };
const HAIR: Record<string, SlotName> = { Hair: 'hair', Hair_Blond: 'hair' };

const casual2 = { ...SKIN, ...HAIR, LightBrown: 'shirt', LightBlue: 'pants', Red_Dark: 'shoes' } as const;
const hoodie = { ...SKIN, ...HAIR, Purple: 'shirt', LightBlue: 'pants' } as const;
const suit = { ...SKIN, ...HAIR, Suit: 'shirt', Tie: 'accent' } as const;
const punk = { ...SKIN, Red: 'hair', Black: 'shirt', LightBlue: 'pants' } as const;
const farmer = { ...SKIN, Brown: 'shirt', LightBlue: 'pants', Beige: 'hat' } as const;
const worker = { ...SKIN, LightBrown: 'shirt', Brown: 'pants', Worker_Vest: 'accent' } as const;
const adventurer = { ...SKIN, ...HAIR, Green: 'shirt', LightGreen: 'accent', Brown: 'pants' } as const;
const beach = { ...SKIN, ...HAIR, LightBrown: 'shirt', Red_Dark: 'pants' } as const;
const womanCasual = { ...SKIN, ...HAIR, White: 'shirt', Orange: 'pants', Grey: 'shoes' } as const;
const womanFormal = { ...SKIN, Red: 'hair', LimeGreen: 'shirt' } as const;
const swat = { ...SKIN, Swat: 'shirt' } as const;

export const LOOKS: readonly Look[] = [
  // Civilians: ten models, and some of them again with another accessory set.
  { id: 'casual', model: 'char.casual2', group: 'civilian', slots: casual2, accessories: [], female: false },
  { id: 'hoodie', model: 'char.hoodie', group: 'civilian', slots: hoodie, accessories: [], female: false },
  { id: 'business', model: 'char.businessman', group: 'civilian', slots: suit, accessories: ['glasses'], female: false },
  { id: 'punk', model: 'char.punk', group: 'civilian', slots: punk, accessories: ['chain'], female: false },
  { id: 'farmer', model: 'char.farmer', group: 'civilian', slots: farmer, accessories: [], female: false },
  { id: 'worker', model: 'char.worker', group: 'civilian', slots: worker, accessories: [], female: false },
  { id: 'hiker', model: 'char.adventurer', group: 'civilian', slots: adventurer, accessories: [], female: false },
  { id: 'beach', model: 'char.beach', group: 'civilian', slots: beach, accessories: ['sunglasses'], female: false },
  { id: 'woman', model: 'char.woman_casual', group: 'civilian', slots: womanCasual, accessories: ['shoulderBag'], female: true },
  { id: 'womanFormal', model: 'char.woman_formal', group: 'civilian', slots: womanFormal, accessories: [], female: true },
  { id: 'casualCap', model: 'char.casual2', group: 'civilian', slots: casual2, accessories: ['cap', 'backpack'], female: false },
  { id: 'student', model: 'char.hoodie', group: 'civilian', slots: hoodie, accessories: ['glasses', 'backpack'], female: false },
  { id: 'womanShades', model: 'char.woman_casual', group: 'civilian', slots: womanCasual, accessories: ['sunglasses', 'watch'], female: true },
  { id: 'commuter', model: 'char.businessman', group: 'civilian', slots: suit, accessories: ['shoulderBag', 'watch'], female: false },
  // Police patrol kit on a plain shirt and trousers; SWAT in armour.
  { id: 'cop', model: 'char.casual2', group: 'cop', slots: casual2, accessories: ['policeCap', 'dutyBelt', 'radio', 'badge'], female: false },
  { id: 'copWoman', model: 'char.woman_casual', group: 'cop', slots: { ...womanCasual, Grey: 'fixed' }, accessories: ['policeCap', 'dutyBelt', 'radio', 'badge'], female: true },
  { id: 'swat', model: 'char.swat', group: 'swat', slots: swat, accessories: ['radio'], female: false },
  // The gangs: Los Tiburones in hoodies and bandanas, Los Halcones in bomber jackets with gold.
  { id: 'tiburon', model: 'char.hoodie', group: 'tiburones', slots: hoodie, accessories: ['bandana'], female: false },
  { id: 'tiburonCap', model: 'char.casual2', group: 'tiburones', slots: casual2, accessories: ['bandana'], female: false },
  { id: 'halcon', model: 'char.punk', group: 'halcones', slots: { ...punk, Red: 'hat' }, accessories: ['chain', 'sunglasses'], female: false },
  { id: 'halconCap', model: 'char.casual2', group: 'halcones', slots: casual2, accessories: ['cap', 'chain'], female: false },
  // Players: the hero, then one look per multiplayer colour slot.
  { id: 'hero', model: 'char.casual2', group: 'player', slots: casual2, accessories: ['watch'], female: false },
  { id: 'player1', model: 'char.hoodie', group: 'player', slots: hoodie, accessories: [], female: false },
  { id: 'player2', model: 'char.adventurer', group: 'player', slots: adventurer, accessories: [], female: false },
  { id: 'player3', model: 'char.punk', group: 'player', slots: punk, accessories: [], female: false },
  { id: 'player4', model: 'char.woman_casual', group: 'player', slots: womanCasual, accessories: [], female: true },
  { id: 'player5', model: 'char.businessman', group: 'player', slots: suit, accessories: [], female: false },
  { id: 'player6', model: 'char.worker', group: 'player', slots: worker, accessories: [], female: false },
  { id: 'player7', model: 'char.beach', group: 'player', slots: beach, accessories: ['sunglasses'], female: false },
  { id: 'player8', model: 'char.woman_formal', group: 'player', slots: womanFormal, accessories: [], female: true },
];

export const LOOK_INDEX: Readonly<Record<string, number>> = Object.fromEntries(LOOKS.map((l, i) => [l.id, i]));
const byGroup = (g: LookGroup): number[] => LOOKS.flatMap((l, i) => (l.group === g ? [i] : []));
const CIVILIANS = byGroup('civilian');
const COPS = byGroup('cop');
const TIBURONES = byGroup('tiburones');
const HALCONES = byGroup('halcones');
const HERO = LOOK_INDEX.hero!;
const PLAYER_SLOTS = ['player1', 'player2', 'player3', 'player4', 'player5', 'player6', 'player7', 'player8'].map((id) => LOOK_INDEX[id]!);

export interface LookSubject {
  id: number;
  role: CharacterRole;
  gang?: GangId | null;
  appearance: Appearance;
}

/** A stable hash of an appearance: players are dressed from it alone (the same on every client and after a reload). */
export function appearanceHash(a: Appearance): number {
  let h = 0x811c9dc5;
  for (const v of [a.skin, a.shirt, a.pants, a.hair, a.hat, Math.round(a.height * 1000), Math.round(a.build * 1000)]) {
    h ^= v >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= h >>> 15;
  }
  return h >>> 0;
}

function pick(list: readonly number[], u: number): number {
  return list[Math.min(list.length - 1, Math.floor(u * list.length))]!;
}

/** The look (index into LOOKS) of a character: pure in his id, role, gang and appearance. */
export function lookOf(c: LookSubject): number {
  const a = c.appearance;
  switch (c.role) {
    case 'player': {
      const slot = PLAYER_COLORS.indexOf(a.shirt);
      return slot >= 0 ? PLAYER_SLOTS[slot]! : HERO;
    }
    case 'cop':
      return pick(COPS, idSeed(c.id, 11) < 0.78 ? 0 : 0.99);
    case 'swat':
      return LOOK_INDEX.swat!;
    case 'gang':
      return pick(c.gang === 'halcones' ? HALCONES : TIBURONES, idSeed(c.id, 12));
    default: {
      // A cap in the appearance asks for a look that wears one; the rest spread evenly over the civilian looks.
      const u = idSeed(c.id, 13);
      if (a.hat) return u < 0.5 ? LOOK_INDEX.casualCap! : LOOK_INDEX.farmer!;
      return pick(CIVILIANS, u);
    }
  }
}

/** Body type (index into rig.BODY_TYPES): pure in the id and the build; heavier builds lean heavy. */
export function bodyTypeOf(c: LookSubject): number {
  if (c.role === 'player') return c.appearance.build > 1.1 ? 3 : 0;
  if (c.role === 'swat') return 3;
  const u = idSeed(c.id, 14);
  const b = c.appearance.build;
  if (b > 1.08) return u < 0.45 ? 2 : u < 0.75 ? 3 : 0;
  if (b < 0.95) return u < 0.55 ? 1 : 0;
  return u < 0.4 ? 0 : u < 0.6 ? 1 : u < 0.8 ? 2 : 3;
}

/** Shoes and accents not in the appearance: picked by id from muted palettes. */
const SHOES = [0x1d1d1f, 0xe8e6e1, 0x5a3b26, 0x2b3a4a, 0x7a1f1f, 0x3a3a3a];
const ACCENTS = [0x2c3e50, 0x7f8c8d, 0x8e5a2b, 0x1f3d2b, 0xb8a27a, 0x4a235a, 0x101010];

/** Slot colours (packed sRGB) of a character in a look: skin, hair, shirt, pants, hat, shoes, accent. */
export function slotColors(c: LookSubject, look: Look, out: number[]): number[] {
  const a = c.appearance;
  const shoes = look.group === 'cop' || look.group === 'swat' ? 0x141414 : SHOES[Math.floor(idSeed(c.id, 15) * SHOES.length)]!;
  let accent = ACCENTS[Math.floor(idSeed(c.id, 16) * ACCENTS.length)]!;
  let hat = a.hat || a.shirt;
  if (look.group === 'tiburones' || look.group === 'halcones') {
    accent = look.group === 'halcones' ? 0xc9a227 : 0x0b5345;
    hat = a.hat || (look.group === 'halcones' ? 0xc9a227 : 0x0e7c7b);
  }
  if (look.group === 'cop') {
    hat = a.hat || 0x0d1b4c;
    accent = 0x141414;
  }
  out.length = 0;
  out.push(a.skin, a.hair, a.shirt, a.pants, hat, shoes, accent);
  return out;
}
