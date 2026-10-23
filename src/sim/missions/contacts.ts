// The people who hand out missions. Everything that tells contacts apart (the runner's offer markers and title
// cards, the HUD's cards and phone names, the map's blips) reads this table; a new contact is a row here, a
// missions file and one line in missions/index.ts.

/** A row of CONTACTS (checked at registration, and by contactById). */
export type ContactId = string;

export interface ContactDef {
  id: ContactId;
  /** Name on the offer card, the title card and the next-step line. */
  name: string;
  /** Name on the subtitle of a call from this contact. */
  phoneName: string;
  /** CSS hex string: the HUD's route line and the map blip. */
  color: string;
  /** Class the HUD puts on the offer card (the stylesheet decides what it looks like). */
  cssClass: string;
  /** Id of the layout POI where this contact waits with the next mission. */
  poiId: string;
  /** Letter on the map blip and in "on your radar". */
  mapLabel: string;
}

export const CONTACTS: ContactDef[] = [
  { id: 'lou', name: 'Mama Lou', phoneName: 'Mama Lou (phone)', color: '#ff4fa3', cssClass: 'lou', poiId: 'lou', mapLabel: 'L' },
  { id: 'dex', name: 'Dex Moreau', phoneName: 'Dex Moreau (phone)', color: '#38e1d2', cssClass: 'dex', poiId: 'dex', mapLabel: 'D' },
];

export function findContact(id: ContactId): ContactDef | undefined {
  return CONTACTS.find((c) => c.id === id);
}

export function contactById(id: ContactId): ContactDef {
  const c = findContact(id);
  if (!c) throw new Error(`Unknown contact "${id}"`);
  return c;
}

/** A contact's CSS colour as the 0xRRGGBB number a marker takes. */
export function contactColorNumber(c: ContactDef): number {
  return parseInt(c.color.slice(1), 16);
}

export function registerContact(def: ContactDef): void {
  if (findContact(def.id)) throw new Error(`Contact "${def.id}" is already registered`);
  CONTACTS.push(def);
}

export function unregisterContact(id: ContactId): void {
  const i = CONTACTS.findIndex((c) => c.id === id);
  if (i >= 0) CONTACTS.splice(i, 1);
}
