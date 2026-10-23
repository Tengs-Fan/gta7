// The completion checklist (map screen, STATS) and the game completion share, built from registries: the story
// missions of each contact (contact and mission registries), each activity that says what completes it
// (ActivityDef.completion), and the entries here. A system adds its own with registerCompletion (properties, turf...).

import { activityKinds, getActivity } from './activities';
import { CONTACTS } from './missions/contacts';
import { PACKAGE_COUNT } from './pickups';
import type { PlayerView, ViewState } from './viewState';

/** The checklist's groups, in the order it shows them. Entries may add others (they come after these). */
export const COMPLETION_GROUPS = ['story', 'collectibles', 'activities', 'properties'] as const;
export type CompletionGroup = (typeof COMPLETION_GROUPS)[number] | (string & {});

export const COMPLETION_GROUP_NAMES: Record<string, string> = { story: 'Story', collectibles: 'Collectibles', activities: 'Activities', properties: 'Properties' };

export interface CompletionRow {
  id: string;
  group: CompletionGroup;
  label: string;
  done: number;
  total: number;
}

export interface CompletionEntry {
  id: string;
  group: CompletionGroup;
  /**
   * Its share of the game completion percentage (all its rows together, done over total). Absent: it does not count
   * towards it. The built-in shares add up to 1.
   */
  weight?: number;
  rows(view: ViewState, me: PlayerView): CompletionRow[];
}

/** Rampages in San Azura (the rampage pickups). */
export const RAMPAGE_COUNT = 3;

const entries: CompletionEntry[] = [];

export function registerCompletion(e: CompletionEntry): void {
  if (entries.some((x) => x.id === e.id)) throw new Error(`Completion entry "${e.id}" is already registered`);
  entries.push(e);
}

export function unregisterCompletion(id: string): boolean {
  const i = entries.findIndex((x) => x.id === id);
  if (i < 0) return false;
  entries.splice(i, 1);
  return true;
}

export function completionEntries(): readonly CompletionEntry[] {
  return entries;
}

/** Every checklist row, grouped in COMPLETION_GROUPS order (registration order within a group). */
export function completionRows(view: ViewState, me: PlayerView): CompletionRow[] {
  const rows: CompletionRow[] = [];
  for (const e of entries) rows.push(...e.rows(view, me));
  const order = (g: string) => {
    const i = (COMPLETION_GROUPS as readonly string[]).indexOf(g);
    return i < 0 ? COMPLETION_GROUPS.length : i;
  };
  return rows.map((r, i) => ({ r, i })).sort((a, b) => order(a.r.group) - order(b.r.group) || a.i - b.i).map((x) => x.r);
}

/** Game completion (whole percent): each weighted entry's done over total, times its weight. */
export function completionPercent(view: ViewState, me: PlayerView): number {
  let sum = 0;
  for (const e of entries) {
    if (!e.weight) continue;
    const rows = e.rows(view, me);
    const total = rows.reduce((a, r) => a + r.total, 0);
    if (total > 0) sum += (rows.reduce((a, r) => a + r.done, 0) / total) * e.weight;
  }
  return Math.round(sum * 100);
}

registerCompletion({
  id: 'story',
  group: 'story',
  weight: 0.5,
  rows: (view, me) =>
    CONTACTS.flatMap((c) => {
      const defs = view.missions.defs.filter((d) => d.giver === c.id);
      if (defs.length === 0) return [];
      return [{ id: `story:${c.id}`, group: 'story', label: c.name, done: defs.filter((d) => me.progress.hasDone(d.id)).length, total: defs.length }];
    }),
});

registerCompletion({
  id: 'packages',
  group: 'collectibles',
  weight: 0.2,
  rows: (_view, me) => [{ id: 'packages', group: 'collectibles', label: 'Hidden packages', done: me.progress.packages.length, total: PACKAGE_COUNT }],
});

registerCompletion({
  id: 'stunts',
  group: 'collectibles',
  weight: 0.15,
  rows: (view, me) => [{ id: 'stunts', group: 'collectibles', label: 'Unique stunt jumps', done: me.progress.stunts.length, total: view.world.layout.ramps.length }],
});

registerCompletion({
  id: 'rampages',
  group: 'collectibles',
  weight: 0.15,
  rows: (_view, me) => [{ id: 'rampages', group: 'collectibles', label: 'Rampages', done: me.progress.rampages.length, total: RAMPAGE_COUNT }],
});

/** A taxi or vigilante career counts as done at this many fares / this level (the milestones' pace). */
export const TAXI_FARES_GOAL = 10;
export const VIGILANTE_GOAL = 10;

registerCompletion({
  id: 'jobs',
  group: 'activities',
  rows: (view, me) => {
    const s = me.progress.stats;
    const courses = view.activities.streetRunCourses();
    return [
      { id: 'taxi', group: 'activities', label: `Taxi fares (to ${TAXI_FARES_GOAL})`, done: Math.min(s.taxiFares, TAXI_FARES_GOAL), total: TAXI_FARES_GOAL },
      { id: 'vigilante', group: 'activities', label: `Vigilante level (to ${VIGILANTE_GOAL})`, done: Math.min(s.vigilanteLevel, VIGILANTE_GOAL), total: VIGILANTE_GOAL },
      { id: 'streetRuns', group: 'activities', label: 'Street Run medals', done: courses.filter((c) => me.progress.streetRuns[c.id]).length, total: courses.length },
    ];
  },
});

registerCompletion({
  id: 'activities',
  group: 'activities',
  rows: (view, me) =>
    activityKinds().flatMap((kind) => {
      const r = getActivity(kind)?.completion?.(view, me);
      return r ? [{ id: `activity:${kind}`, group: 'activities', ...r }] : [];
    }),
});
