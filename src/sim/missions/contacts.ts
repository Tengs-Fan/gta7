// The people who hand out missions. Everything that tells contacts apart (the runner's offer markers and title
// cards, the HUD's cards and phone names, the map's blips) reads this table; a new contact is a row here, a
// missions file and one line in missions/index.ts.

import type { Progress } from '../progress';
import type { MissionDef } from './runner';

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
  { id: 'vera', name: 'Vera Salgado', phoneName: 'Vera Salgado (phone)', color: '#b8e62e', cssClass: 'vera', poiId: 'vera', mapLabel: 'V' },
];

/** What a contact says on the phone while the player is busy with a mission. */
export const BUSY_LINE = "You've got your hands full. Call me when you're done.";

/** What a contact says on the phone about work they have (or have not). */
export function offerLine(c: ContactDef, def: MissionDef | undefined): string {
  return def ? `I've got work for you: "${def.title}". Come see me, ${c.mapLabel} on your radar.` : "Nothing for you right now. I'll call you.";
}

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

/**
 * Whether a contact is revealed to the player (phone, map legend, checklist). A contact is listed once nothing locks it: no story finale (a mission with an
 * outro title card, The Big Score's CHAPTER 1 COMPLETE) stands undone among what its first mission requires, directly or through
 * the missions before it. Lou and Dex are in a new game's phone; a chapter 2 contact comes in after The Big Score. A
 * contact with no missions at all is listed.
 */
export function contactUnlocked(defs: readonly MissionDef[], progress: Pick<Progress, 'hasDone'>, id: string): boolean {
  const first = defs.find((d) => d.giver === id);
  if (!first) return true;
  const seen = new Set<string>();
  const todo = [...first.requires];
  while (todo.length > 0) {
    const r = todo.pop()!;
    if (seen.has(r)) continue;
    seen.add(r);
    const d = defs.find((x) => x.id === r);
    if (!d) continue;
    if (d.outro && !progress.hasDone(d.id)) return false;
    todo.push(...d.requires);
  }
  return true;
}
