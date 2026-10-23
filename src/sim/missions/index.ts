// The San Azura story: every contact's missions, in the order they are offered.

import { findContact, type ContactId } from './contacts';
import { DEX } from './dex';
import { LOU } from './lou';
import type { MissionDef } from './runner';

const story: MissionDef[] = [...LOU, ...DEX];

/** Every mission, a contact's after another's. The array itself is shared (MissionSystem.defs), so registrations show up in it. */
export const STORY: readonly MissionDef[] = story;

/** Adds a contact's missions after the ones already there. */
export function registerContactMissions(contact: ContactId, defs: readonly MissionDef[]): void {
  if (!findContact(contact)) throw new Error(`Unknown contact "${contact}"`);
  for (const d of defs) {
    if (d.giver !== contact) throw new Error(`Mission "${d.id}" is not ${contact}'s`);
    if (story.some((s) => s.id === d.id)) throw new Error(`Mission "${d.id}" is already registered`);
  }
  story.push(...defs);
}

export function unregisterContactMissions(defs: readonly MissionDef[]): void {
  for (const d of defs) {
    const i = story.indexOf(d);
    if (i >= 0) story.splice(i, 1);
  }
}
